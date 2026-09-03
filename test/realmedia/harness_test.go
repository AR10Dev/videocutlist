//go:build realmedia

package realmedia

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const (
	fixturePath = "test/fixtures/real-media/sintel-trailer.mp4"
	bearerToken = "real-media-test-token"
	startupWait = 20 * time.Second
)

type process struct {
	cmd    *exec.Cmd
	base   string
	log    *strings.Builder
	cancel context.CancelFunc
}

func startProcess(t *testing.T, root string) *process {
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
	port := reservePort(t)
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
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	p := &process{cmd: cmd, base: "http://127.0.0.1:" + port, log: logBuffer, cancel: cancel}
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
	})
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(startupWait)
	for time.Now().Before(deadline) {
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

func reservePort(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
}

func copyFile(source, destination string) error {
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
