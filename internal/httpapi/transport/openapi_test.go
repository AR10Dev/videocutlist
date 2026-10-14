package transport

import (
	"encoding/json"
	"testing"
)

func TestNullableCursorPreservesOmittedNullAndValue(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		wantJSON    string
		wantPresent bool
		wantNull    bool
		wantValue   string
	}{
		{
			name:     "omitted",
			input:    `{"folders":[],"items":[]}`,
			wantJSON: `{"folders":[],"items":[]}`,
		},
		{
			name:        "null",
			input:       `{"folders":[],"items":[],"nextCursor":null}`,
			wantJSON:    `{"folders":[],"items":[],"nextCursor":null}`,
			wantPresent: true,
			wantNull:    true,
		},
		{
			name:        "value",
			input:       `{"folders":[],"items":[],"nextCursor":"next"}`,
			wantJSON:    `{"folders":[],"items":[],"nextCursor":"next"}`,
			wantPresent: true,
			wantValue:   "next",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var page FolderPage
			if err := json.Unmarshal([]byte(test.input), &page); err != nil {
				t.Fatal(err)
			}
			if page.NextCursor.IsSpecified() != test.wantPresent {
				t.Fatalf("IsSpecified() = %v, want %v", page.NextCursor.IsSpecified(), test.wantPresent)
			}
			if page.NextCursor.IsNull() != test.wantNull {
				t.Fatalf("IsNull() = %v, want %v", page.NextCursor.IsNull(), test.wantNull)
			}
			if test.wantValue != "" {
				got, err := page.NextCursor.Get()
				if err != nil {
					t.Fatal(err)
				}
				if got != test.wantValue {
					t.Fatalf("Get() = %q, want %q", got, test.wantValue)
				}
			}

			gotJSON, err := json.Marshal(page)
			if err != nil {
				t.Fatal(err)
			}
			if string(gotJSON) != test.wantJSON {
				t.Fatalf("MarshalJSON() = %s, want %s", gotJSON, test.wantJSON)
			}
		})
	}

	var required ProjectPage
	if err := json.Unmarshal([]byte(`{"items":[],"nextCursor":null}`), &required); err != nil {
		t.Fatal(err)
	}
	if !required.NextCursor.IsNull() {
		t.Fatal("required nullable field did not retain explicit null")
	}
	gotJSON, err := json.Marshal(required)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotJSON) != `{"items":[],"nextCursor":null}` {
		t.Fatalf("MarshalJSON() = %s, want explicit required null", gotJSON)
	}
}

func TestDestinationsResponseSerializesCompleteEnvelope(t *testing.T) {
	response := DestinationsResponse{
		Destinations: []Destination{{
			Id:    "download",
			Kind:  DestinationKindDownload,
			Label: "Downloads",
		}},
		Capabilities: DestinationCapabilities{SaveBesideSource: true},
	}

	gotJSON, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := `{"capabilities":{"saveBesideSource":true},"destinations":[{"id":"download","kind":"download","label":"Downloads"}]}`
	if string(gotJSON) != wantJSON {
		t.Fatalf("MarshalJSON() = %s, want %s", gotJSON, wantJSON)
	}
}

func TestOptionalDefaultedBooleanPreservesExplicitFalse(t *testing.T) {
	var omitted Segment
	if err := json.Unmarshal([]byte(`{"startMs":0,"endMs":1}`), &omitted); err != nil {
		t.Fatal(err)
	}
	if omitted.Included != nil {
		t.Fatalf("omitted Included = %v, want nil", *omitted.Included)
	}

	var explicitFalse Segment
	if err := json.Unmarshal([]byte(`{"startMs":0,"endMs":1,"included":false}`), &explicitFalse); err != nil {
		t.Fatal(err)
	}
	if explicitFalse.Included == nil || *explicitFalse.Included {
		t.Fatalf("explicit false Included = %v, want pointer to false", explicitFalse.Included)
	}
	gotJSON, err := json.Marshal(explicitFalse)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotJSON) != `{"endMs":1,"included":false,"startMs":0}` {
		t.Fatalf("MarshalJSON() = %s, want explicit false retained", gotJSON)
	}
}

func TestDetectionCandidateOneOfTypesRoundTrip(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		check   func(t *testing.T, candidate DetectionCandidate)
	}{
		{
			name:    "range",
			payload: `{"id":"d1","mediaId":"m1","projectId":"p1","projectRevision":2,"startMs":10,"endMs":20,"source":"silence"}`,
			check: func(t *testing.T, candidate DetectionCandidate) {
				got, err := candidate.AsDetectionRangeCandidate()
				if err != nil {
					t.Fatal(err)
				}
				if got.StartMs != 10 || got.EndMs != 20 || got.Source != DetectionRangeCandidateSourceSilence || !got.Source.Valid() {
					t.Fatalf("decoded range candidate = %+v", got)
				}
			},
		},
		{
			name:    "point",
			payload: `{"id":"d2","mediaId":"m1","projectId":"p1","projectRevision":2,"pointMs":30,"source":"scene"}`,
			check: func(t *testing.T, candidate DetectionCandidate) {
				got, err := candidate.AsDetectionPointCandidate()
				if err != nil {
					t.Fatal(err)
				}
				if got.PointMs != 30 || got.Source != DetectionPointCandidateSourceScene || !got.Source.Valid() {
					t.Fatalf("decoded point candidate = %+v", got)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var candidate DetectionCandidate
			if err := json.Unmarshal([]byte(test.payload), &candidate); err != nil {
				t.Fatal(err)
			}
			test.check(t, candidate)
			gotJSON, err := json.Marshal(candidate)
			if err != nil {
				t.Fatal(err)
			}
			if string(gotJSON) != test.payload {
				t.Fatalf("round-trip JSON = %s, want %s", gotJSON, test.payload)
			}
		})
	}
}

func TestAutomationResponseOneOfTypesRoundTrip(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		check   func(t *testing.T, response Automation200JSONResponseBody)
	}{
		{
			name:    "project import",
			payload: `{"projectId":"p1"}`,
			check: func(t *testing.T, response Automation200JSONResponseBody) {
				got, err := response.AsAutomation200JSONResponseBody0()
				if err != nil {
					t.Fatal(err)
				}
				if got.ProjectId != "p1" {
					t.Fatalf("decoded project ID = %q, want p1", got.ProjectId)
				}
			},
		},
		{
			name:    "export text",
			payload: `{"filename":"cuts.csv","content":"start,end"}`,
			check: func(t *testing.T, response Automation200JSONResponseBody) {
				got, err := response.AsAutomation200JSONResponseBody1()
				if err != nil {
					t.Fatal(err)
				}
				if got.Filename != "cuts.csv" || got.Content != "start,end" {
					t.Fatalf("decoded export body = %+v", got)
				}
			},
		},
		{
			name:    "job",
			payload: `{"id":"j1","type":"export","state":"queued","revision":1,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}`,
			check: func(t *testing.T, response Automation200JSONResponseBody) {
				got, err := response.AsJob()
				if err != nil {
					t.Fatal(err)
				}
				if got.Id != "j1" || got.Type != JobTypeExport {
					t.Fatalf("decoded job = %+v", got)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var response Automation200JSONResponseBody
			if err := json.Unmarshal([]byte(test.payload), &response); err != nil {
				t.Fatal(err)
			}
			test.check(t, response)
			gotJSON, err := json.Marshal(response)
			if err != nil {
				t.Fatal(err)
			}
			if string(gotJSON) != test.payload {
				t.Fatalf("round-trip JSON = %s, want %s", gotJSON, test.payload)
			}
		})
	}
}

func TestNumberUsesFloat64TransportType(t *testing.T) {
	var state UIState
	if err := json.Unmarshal([]byte(`{"playheadMs":0,"zoom":1.0000000001,"muted":false}`), &state); err != nil {
		t.Fatal(err)
	}
	if state.Zoom != 1.0000000001 {
		t.Fatalf("decoded zoom = %.10f, want %.10f", state.Zoom, 1.0000000001)
	}
}

func TestInt64FormatUsesInt64TransportType(t *testing.T) {
	const largestInt64 = int64(1<<63 - 1)
	payload := `{"id":"j1","type":"export","state":"succeeded","revision":1,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","result":{"sizeBytes":9223372036854775807,"retainUntil":"2026-01-02T00:00:00Z"}}`
	var job Job
	if err := json.Unmarshal([]byte(payload), &job); err != nil {
		t.Fatal(err)
	}
	if job.Result == nil || job.Result.SizeBytes != largestInt64 {
		t.Fatalf("decoded sizeBytes = %v, want %d", job.Result, largestInt64)
	}
}
