//go:build realmedia

package realmedia

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"videocutlist/internal/httpapi"
)

const (
	fixturePath = "test/fixtures/real-media/sintel-trailer.mp4"
	bearerToken = "real-media-test-token"
	startupWait = 20 * time.Second
)

type process struct {
	cmd                *exec.Cmd
	base               string
	log                *strings.Builder
	cancel             context.CancelFunc
	forbidden          []string
	redactionViolation bool
	redactionMu        sync.Mutex
}

type redactionBody struct {
	io.ReadCloser
	process  *process
	contents strings.Builder
}

func (b *redactionBody) Read(data []byte) (int, error) {
	n, err := b.ReadCloser.Read(data)
	_, _ = b.contents.Write(data[:n])
	if err == io.EOF {
		b.check()
	}
	return n, err
}
func (b *redactionBody) Close() error { b.check(); return b.ReadCloser.Close() }
func (b *redactionBody) check() {
	value := b.contents.String()
	for _, forbidden := range b.process.forbidden {
		if forbidden != "" && strings.Contains(value, forbidden) {
			b.process.redactionMu.Lock()
			b.process.redactionViolation = true
			b.process.redactionMu.Unlock()
			return
		}
	}
}

var executedRoutes sync.Map

func TestMain(m *testing.M) {
	code := m.Run()
	if code == 0 {
		for _, kind := range httpapi.RouteCoverageKinds() {
			if _, ok := executedRoutes.Load(kind); !ok {
				fmt.Fprintf(os.Stderr, "real-media route not exercised: %s\n", kind)
				code = 1
			}
		}
		for _, route := range []string{"GET /api/v1/health", "GET /api/v1/ready", "GET /", "GET /metrics"} {
			if _, ok := executedRoutes.Load(route); !ok {
				fmt.Fprintf(os.Stderr, "real-media route not exercised: %s\n", route)
				code = 1
			}
		}
	}
	os.Exit(code)
}

func recordRoute(method, path string) {
	path = strings.Split(path, "?")[0]
	if kind := httpapi.RouteCoverageKind(method, path); kind != "" {
		executedRoutes.Store(kind, true)
	}
	if path == "/" || path == "/metrics" || path == "/api/v1/health" || path == "/api/v1/ready" {
		executedRoutes.Store(method+" "+path, true)
	}
}

func startProcess(t *testing.T, root string) *process {
	return startProcessWithEnv(t, root, nil)
}

func startProcessWithEnv(t *testing.T, root string, overrides map[string]string) *process {
	t.Helper()
	repositoryRoot := repositoryRoot(t)
	fixture := filepath.Join(repositoryRoot, fixturePath)
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Fatalf("real-media suite requires %s; install it before running make test-real-media", tool)
		}
	}
	if _, err := os.Stat(fixture); err != nil {
		t.Fatalf("real-media fixture is unavailable; run test/harness/acquire-real-media.sh (make test-real-media): %v", err)
	}
	binary := filepath.Join(t.TempDir(), "videocutlist")
	buildArgs := []string{"build", "-o", binary, "./cmd/videocutlist"}
	if _, err := os.Stat(filepath.Join(repositoryRoot, "internal/web/webassets/dist/index.html")); err == nil {
		buildArgs = []string{"build", "-tags", "embed_frontend", "-o", binary, "./cmd/videocutlist"}
	}
	build := exec.Command("go", buildArgs...)
	build.Dir = repositoryRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build production process: %v\n%s", err, output)
	}
	// Port zero lets the kernel allocate and retain the listener atomically;
	// reserving and then closing a port introduces a startup TOCTOU race.
	port := "0"
	mediaRoot := filepath.Join(root, "media")
	if err := os.MkdirAll(mediaRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(fixture, filepath.Join(mediaRoot, "sintel-trailer.mp4")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, binary)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	logBuffer := new(strings.Builder)
	cmd.Stdout, cmd.Stderr = logBuffer, logBuffer
	cmd.Env = append(os.Environ(),
		"VIDEOCUTLIST_DATABASE_PATH="+filepath.Join(root, "videocutlist.db"),
		"VIDEOCUTLIST_CACHE_DIR="+filepath.Join(root, "cache"),
		"VIDEOCUTLIST_EXPORT_DIR="+filepath.Join(root, "exports"),
		"VIDEOCUTLIST_MEDIA_ROOTS_JSON={\"fixture\":\""+mediaRoot+"\"}",
		"VIDEOCUTLIST_LISTEN_ADDRESS=127.0.0.1",
		"VIDEOCUTLIST_PORT="+port,
		"VIDEOCUTLIST_AUTH_MODE=bearer",
		"VIDEOCUTLIST_BEARER_TOKEN="+bearerToken,
	)
	for key, value := range overrides {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	p := &process{cmd: cmd, log: logBuffer, cancel: cancel, forbidden: []string{root, mediaRoot, filepath.Join(root, "videocutlist.db"), filepath.Join(root, "cache"), filepath.Join(root, "exports"), fixture}}
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		}
		cancel()
		waited := make(chan struct{})
		go func() {
			_ = cmd.Wait()
			close(waited)
		}()
		select {
		case <-waited:
		case <-time.After(5 * time.Second):
			if cmd.Process != nil {
				_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			}
			<-waited
		}
		assertNoSecrets(t, p)
	})
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(startupWait)
	for time.Now().Before(deadline) {
		if p.base == "" {
			if match := regexp.MustCompile(`"listen_addr":"(127\.0\.0\.1:[0-9]+)"`).FindStringSubmatch(logBuffer.String()); len(match) == 2 {
				p.base = "http://" + match[1]
			}
		}
		if p.base == "" {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		resp, err := client.Get(p.base + "/api/v1/ready")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return p
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("production process did not become ready\n%s", boundedLog(p.log.String()))
	return nil
}

func (p *process) stop() {
	if p.cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGTERM)
	p.cancel()
	_ = p.cmd.Wait()
}

func (p *process) requestNoAuth(t *testing.T, method, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, p.base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	recordRoute(method, path)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func (p *process) request(t *testing.T, method, path string) *http.Response {
	return p.requestBody(t, method, path, nil)
}

func (p *process) requestBody(t *testing.T, method, path string, body any) *http.Response {
	t.Helper()
	var payload io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		payload = bytes.NewReader(data)
	}
	return p.requestHeaders(t, method, path, payload, nil)
}

func (p *process) requestHeaders(t *testing.T, method, path string, body io.Reader, headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, p.base+path, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+bearerToken)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	recordRoute(method, path)
	if resp != nil {
		for _, values := range resp.Header {
			for _, value := range values {
				for _, forbidden := range p.forbidden {
					if forbidden != "" && strings.Contains(value, forbidden) {
						p.redactionMu.Lock()
						p.redactionViolation = true
						p.redactionMu.Unlock()
					}
				}
			}
		}
		resp.Body = &redactionBody{ReadCloser: resp.Body, process: p}
	}
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", method, path, err, boundedLog(p.log.String()))
	}
	return resp
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate real-media harness")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(filename), "../.."))
}

func copyFile(source, destination string) error {
	if _, err := os.Stat(destination); err == nil {
		return nil
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func assertNoSecrets(t *testing.T, p *process) {
	t.Helper()
	p.redactionMu.Lock()
	violated := p.redactionViolation
	p.redactionMu.Unlock()
	for _, value := range p.forbidden {
		if strings.Contains(p.log.String(), value) {
			violated = true
		}
	}
	if violated {
		t.Fatal("response or process log exposed forbidden data")
	}
}

func boundedLog(value string) string {
	const limit = 16 * 1024
	if len(value) > limit {
		return value[len(value)-limit:]
	}
	return value
}

func waitFor(t *testing.T, deadline time.Duration, check func() bool) {
	t.Helper()
	until := time.Now().Add(deadline)
	for time.Now().Before(until) {
		if check() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("condition did not complete before %s", deadline)
}
