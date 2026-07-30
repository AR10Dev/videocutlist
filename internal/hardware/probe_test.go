package hardware

import (
	"context"
	"os"
	"strings"
	"testing"
)

func init() {
	if os.Getenv("EDITAPP_HARDWARE_HELPER") != "1" {
		return
	}
	log := os.Getenv("EDITAPP_HARDWARE_LOG")
	if log != "" {
		file, _ := os.OpenFile(log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if file != nil {
			_, _ = file.WriteString("probe\n")
			_ = file.Close()
		}
	}
	os.Exit(1)
}

func TestDetectorCachesFailuresAndFallsBackToSoftware(t *testing.T) {
	log := t.TempDir() + "/probes"
	t.Setenv("EDITAPP_HARDWARE_HELPER", "1")
	t.Setenv("EDITAPP_HARDWARE_LOG", log)
	detector := &Detector{Path: os.Args[0]}
	if detector.Probe(context.Background(), NVENC).Available {
		t.Fatal("helper must reject nvenc")
	}
	if detector.Probe(context.Background(), NVENC).Available {
		t.Fatal("cached failure changed")
	}
	data, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(data), "probe\n") != 1 {
		t.Fatalf("probe was not cached: %q", data)
	}
	if got := detector.Choose(context.Background(), "nvenc,vaapi,qsv"); got != Software {
		t.Fatalf("Choose() = %q, want software", got)
	}
}
