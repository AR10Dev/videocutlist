package media

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestContractJSONShapes(t *testing.T) {
	for _, test := range []struct {
		name  string
		value any
		want  string
	}{
		{"media", Media{ID: "m_test", RootID: "private-root", Name: "clip.mp4", DurationMS: 1000, SizeBytes: 10, Container: "mp4", Streams: map[string]any{}, ETag: "v1"}, `{"id":"m_test","name":"clip.mp4","durationMs":1000,"sizeBytes":10,"container":"mp4","streams":{},"etag":"v1"}`},
		{"media page", MediaPage{Items: []Media{}}, `{"items":[],"nextCursor":null}`},
		{"folder page", FolderPage{Folders: []FolderNode{{ID: "f_test", Label: "clips"}}, Items: []Media{}, NextCursor: new("next")}, `{"folders":[{"id":"f_test","label":"clips"}],"items":[],"nextCursor":"next"}`},
		{"status", LibraryStatus{State: LibraryReadyEmpty, Message: "empty"}, `{"state":"ready_empty","message":"empty"}`},
		{"import", ImportJob{ID: "j_test", State: "succeeded", Progress: 1, RootResults: map[string]RootLibraryStatus{"library": {State: LibraryReadyWithMedia}}}, `{"id":"j_test","state":"succeeded","progress":1,"indexed":0,"rootResults":{"library":{"state":"ready_with_media"}}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := json.Marshal(test.value)
			if err != nil {
				t.Fatal(err)
			}
			var actual, expected any
			if err := json.Unmarshal(got, &actual); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(test.want), &expected); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, expected) {
				t.Fatalf("JSON = %s, want %s", got, test.want)
			}
		})
	}
}
