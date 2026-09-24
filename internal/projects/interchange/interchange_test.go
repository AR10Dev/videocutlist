package interchange

import (
	"strings"
	"testing"
	"videocutlist/internal/projects/model"
)

func TestCSVRoundTrip(t *testing.T) {
	in := []byte("start,end,label\n00:00:01.000,00:00:02.500,Intro\n")
	got, err := ParseCSV(in, 5000)
	if err != nil || len(got) != 1 || got[0].StartMS != 1000 {
		t.Fatalf("parse: %#v %v", got, err)
	}
	out, err := ExportCSV(got)
	if err != nil || string(out) != string(in) {
		t.Fatalf("export: %q %v", out, err)
	}
}

func TestInterchangeLabelsAllowPathSeparators(t *testing.T) {
	csvData := []byte("start,end,label\n00:00:01.000,00:00:02.500,Intro/\\Take\n")
	segments, err := ParseCSV(csvData, 5000)
	if err != nil || len(segments) != 1 || segments[0].Label != `Intro/\Take` {
		t.Fatalf("parse separator label: %#v %v", segments, err)
	}
	csvRoundTrip, err := ExportCSV(segments)
	if err != nil || string(csvRoundTrip) != string(csvData) {
		t.Fatalf("csv separator round trip: %q %v", csvRoundTrip, err)
	}

	chaptersData := []byte("00:00:01.000 --> 00:00:02.500 Intro/\\Take\n")
	chapters, err := ParseChapters(chaptersData, 5000)
	if err != nil || len(chapters) != 1 || chapters[0].Label != `Intro/\Take` {
		t.Fatalf("parse chapter separator label: %#v %v", chapters, err)
	}
	chaptersRoundTrip, err := ExportChapters(chapters)
	if err != nil || string(chaptersRoundTrip) != string(chaptersData) {
		t.Fatalf("chapter separator round trip: %q %v", chaptersRoundTrip, err)
	}
}

func TestInterchangeLabelsUseUnicodeCodePointLimit(t *testing.T) {
	exact := strings.Repeat("界", 200)
	if _, err := ParseCSV([]byte("start,end,label\n1,2,"+exact+"\n"), 5000); err != nil {
		t.Fatalf("200 code points rejected: %v", err)
	}
	if _, err := ParseCSV([]byte("start,end,label\n1,2,"+exact+"界\n"), 5000); err == nil {
		t.Fatal("201 code points accepted")
	}
}
func TestChaptersDeriveEndsAndRejectOverlap(t *testing.T) {
	got, err := ParseChapters([]byte("00:00:01.000 One\n00:00:03.000 Two\n"), 5000)
	if err != nil || got[0].EndMS != 3000 || got[1].EndMS != 5000 {
		t.Fatalf("chapters: %#v %v", got, err)
	}
	if _, err := ParseCSV([]byte("start,end,label\n1,2,a\n1,3,b\n"), 5000); err == nil {
		t.Fatal("duplicate timestamps accepted")
	}
}
func TestChaptersRoundTripExplicitEnds(t *testing.T) {
	segments := []model.Segment{{StartMS: 1000, EndMS: 2000, Label: "One"}, {StartMS: 4000, EndMS: 4500, Label: "Two words"}}
	data, err := ExportChapters(segments)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseChapters(data, 10000)
	if err != nil || len(got) != 2 || got[0].EndMS != 2000 || got[1].EndMS != 4500 || got[1].Label != "Two words" {
		t.Fatalf("round trip: %q %#v %v", data, got, err)
	}
}
func TestTimestampOverflowRejected(t *testing.T) {
	if _, err := ParseTimestamp("3000000000000:00:00"); err == nil {
		t.Fatal("overflow accepted")
	}
	if _, err := ParseTimestamp("9223372036854776"); err == nil {
		t.Fatal("seconds overflow accepted")
	}
}
func TestRejectUnknownAndOversize(t *testing.T) {
	if _, err := ParseCSV([]byte("start,end,path\n1,2,/tmp/x\n"), 5000); err == nil {
		t.Fatal("unknown field accepted")
	}
	if _, err := ParseChapters(make([]byte, MaxInputBytes+1), 5000); err == nil {
		t.Fatal("oversize accepted")
	}
}
