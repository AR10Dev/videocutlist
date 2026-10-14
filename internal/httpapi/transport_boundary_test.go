package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"videocutlist/internal/export"
	"videocutlist/internal/httpapi/transport"
	"videocutlist/internal/jobs/view"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

func TestProjectInputTransportKeepsIncludedDefault(t *testing.T) {
	var input ProjectInput
	body := `{"revision":1,"schemaVersion":2,"name":"Project","items":[{"id":"i_001","mediaId":"m_001","segments":[{"startMs":0,"endMs":10},{"startMs":10,"endMs":20,"included":false},{"startMs":20,"endMs":30,"included":true}],"exportOptions":{"streamIndexes":[]}}]}`
	if err := json.Unmarshal([]byte(body), &input); err != nil {
		t.Fatal(err)
	}
	mapped := input.input()
	segments := mapped.Document.Items[0].Segments
	if len(segments) != 3 || !segments[0].IsIncluded() || segments[1].IsIncluded() || !segments[2].IsIncluded() {
		t.Fatalf("mapped segment inclusion = %#v, want default/true included and explicit false retained", segments)
	}
	if mapped.Items[0].ExportOptions.StreamIndexes == nil {
		t.Fatal("explicit empty streamIndexes was lost")
	}
	response, ok := projectToTransport(projects.Project{Document: mapped.Document, Revision: mapped.Revision})
	if !ok || response.Items[0].Segments[1].Included == nil || *response.Items[0].Segments[1].Included {
		t.Fatalf("explicit false was not preserved in response mapping: %#v", response)
	}
}

func TestMediaPageTransportKeepsNullCursorAndHidesRootID(t *testing.T) {
	page := librarymedia.MediaPage{Items: []librarymedia.Media{{
		ID: "m_001", RootID: "/private/media", Name: "clip.mp4", DurationMS: 1000,
		SizeBytes: 12, Container: "mp4", Streams: map[string]any{}, ETag: "etag",
	}}}
	mapped, err := mediaPageToTransport(page)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(mapped)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"nextCursor":null`) {
		t.Fatalf("media page lost explicit null cursor: %s", encoded)
	}
	if strings.Contains(string(encoded), "/private/media") || strings.Contains(string(encoded), "rootId") {
		t.Fatalf("media page leaked an internal root ID: %s", encoded)
	}
}

func TestExportPreflightTransportPreservesEmptyCollectionsAndFinding(t *testing.T) {
	streamIndex := 3
	mapped := exportPreflightTransport(export.PreflightResult{
		Allowed: true, Selection: []int{}, Findings: []export.Finding{{
			Severity: "allowed", Code: "selected", Message: "selected stream", StreamIndex: &streamIndex,
		}},
	})
	if mapped.Selection == nil || len(mapped.Selection) != 0 || len(mapped.Findings) != 1 {
		t.Fatalf("preflight mapping lost explicit collections: %#v", mapped)
	}
	finding := mapped.Findings[0]
	if finding.Code != "selected" || finding.Severity != transport.Allowed || finding.StreamIndex == nil || *finding.StreamIndex != streamIndex {
		t.Fatalf("preflight finding mapping = %#v", finding)
	}
}

func TestDetectionCandidateTransportUsesTypedUnionVariant(t *testing.T) {
	pointMS := int64(123)
	point, ok, err := detectionCandidateTransport(model.Candidate{
		ID: "c_point", MediaID: "m_001", ProjectID: "p_001", ProjectRevision: 3,
		PointMS: &pointMS, Source: model.DetectScene,
	})
	if err != nil || !ok {
		t.Fatalf("point candidate mapping = (%v, %v), want success", ok, err)
	}
	pointValue, err := point.AsDetectionPointCandidate()
	if err != nil || pointValue.PointMs != int(pointMS) {
		t.Fatalf("point union = (%#v, %v), want pointMs %d", pointValue, err, pointMS)
	}

	rangeCandidate, ok, err := detectionCandidateTransport(model.Candidate{
		ID: "c_range", MediaID: "m_001", ProjectID: "p_001", ProjectRevision: 3,
		StartMS: 10, EndMS: 20, Source: model.DetectSilence,
	})
	if err != nil || !ok {
		t.Fatalf("range candidate mapping = (%v, %v), want success", ok, err)
	}
	rangeValue, err := rangeCandidate.AsDetectionRangeCandidate()
	if err != nil || rangeValue.StartMs != 10 || rangeValue.EndMs != 20 {
		t.Fatalf("range union = (%#v, %v), want [10,20)", rangeValue, err)
	}

	_, ok, err = detectionCandidateTransport(model.Candidate{ID: "invalid_scene", Source: model.DetectScene, StartMS: 10, EndMS: 12})
	if err != nil || ok {
		t.Fatalf("invalid scene mapping = (%v, %v), want nonrepresentable without error", ok, err)
	}
}

func TestMCPCredentialTransportPreservesFalseAndEmptyLists(t *testing.T) {
	allowNonExpiring := false
	empty := []string{}
	mapped := domainMCPCredentialInput(transport.MCPCredentialCreate{
		Permissions:      []string{},
		AllowNonExpiring: &allowNonExpiring,
		MediaScope:       transport.MCPMediaScope{Kind: "roots", RootIds: &empty},
		ProjectScope:     transport.MCPProjectScope{Kind: "projects", ProjectIds: &empty},
	})
	if mapped.AllowNonExpiring || mapped.Permissions == nil || mapped.MediaScope.RootIDs == nil || mapped.ProjectScope.ProjectIDs == nil {
		t.Fatalf("mapped credential lost explicit false or empty lists: %#v", mapped)
	}
}

func TestBatchExportSubmissionTransportPreservesNilAndEmptyJobs(t *testing.T) {
	for _, test := range []struct {
		name string
		jobs []view.Job
		want string
	}{{name: "nil", jobs: nil, want: `"jobs":null`}, {name: "empty", jobs: []view.Job{}, want: `"jobs":[]`}} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeBatchExportSubmissionJSON(response, "request", "b_001", test.jobs)
			if !strings.Contains(response.Body.String(), test.want) {
				t.Fatalf("batch submission body = %s, want %s", response.Body.String(), test.want)
			}
		})
	}
}
