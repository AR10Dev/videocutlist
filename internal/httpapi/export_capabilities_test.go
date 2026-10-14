package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	exporter "videocutlist/internal/export"
)

type capabilityServiceFunc func(context.Context, string) (exporter.Capabilities, error)

func (f capabilityServiceFunc) Capabilities(ctx context.Context, mediaID string) (exporter.Capabilities, error) {
	return f(ctx, mediaID)
}

const contractCapabilityMediaID = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestExportCapabilitiesHandlerContractAndRoutedErrors(t *testing.T) {
	contract := newHandlerContract(t)
	var capability exporter.Capabilities
	var capabilityErr error
	service := capabilityServiceFunc(func(_ context.Context, gotID string) (exporter.Capabilities, error) {
		if gotID != contractCapabilityMediaID {
			return exporter.Capabilities{}, errors.New("unexpected media identifier")
		}
		return capability, capabilityErr
	})
	server := newHandlerContractServer(t, Config{ExportCapabilities: service})
	target := "/api/v2/export-capabilities/media/" + contractCapabilityMediaID

	for _, test := range []struct {
		name        string
		result      exporter.Capabilities
		wantSupport bool
		wantReason  string
	}{
		{name: "supported", result: exporter.Capabilities{Strategies: []exporter.StrategyCapability{{Strategy: "hybrid_smart_cut", Supported: true, Reasons: []string{}}}}, wantSupport: true},
		{name: "unsupported", result: exporter.Capabilities{Strategies: []exporter.StrategyCapability{{Strategy: "hybrid_smart_cut", Supported: false, Reasons: []string{"unsupported_video_codec"}}}}, wantReason: "unsupported_video_codec"},
	} {
		t.Run(test.name, func(t *testing.T) {
			capability, capabilityErr = test.result, nil
			contract.requireValidRequest(t, http.MethodGet, target, "", nil)
			request := handlerContractRequest(http.MethodGet, target, "", nil)
			response := contract.serve(t, server, http.MethodGet, target, "", nil)
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			contract.requireValidResponse(t, request, response)
			if !strings.Contains(response.Body.String(), `"supported":`+map[bool]string{true: "true", false: "false"}[test.wantSupport]) {
				t.Fatalf("supported value missing from %s", response.Body.String())
			}
			if test.wantReason != "" && !strings.Contains(response.Body.String(), `"reasons":["`+test.wantReason+`"]`) {
				t.Fatalf("reason missing from %s", response.Body.String())
			}
		})
	}

	t.Run("safe service error", func(t *testing.T) {
		capabilityErr = errors.New("private probe path: /srv/private/source.mkv")
		request := handlerContractRequest(http.MethodGet, target, "", nil)
		response := contract.serve(t, server, http.MethodGet, target, "", nil)
		if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "/srv/private/source.mkv") {
			t.Fatalf("unsafe error response status=%d body=%s", response.Code, response.Body.String())
		}
		contract.requireValidResponse(t, request, response)
		requireContractErrorRequestID(t, response)
	})

	t.Run("invalid media ID is rejected by the actual route", func(t *testing.T) {
		invalidTarget := "/api/v2/export-capabilities/media/not-a-media-id"
		contract.requireInvalidRequest(t, http.MethodGet, invalidTarget, "", nil)
		request := handlerContractRequest(http.MethodGet, invalidTarget, "", nil)
		response := contract.serve(t, server, http.MethodGet, invalidTarget, "", nil)
		if response.Code != http.StatusNotFound {
			t.Fatalf("invalid ID status=%d body=%s", response.Code, response.Body.String())
		}
		contract.requireValidResponse(t, request, response)
		requireContractErrorRequestID(t, response)
	})
}

func TestExportCapabilitiesRouteRequiresConfiguredBearerAuthentication(t *testing.T) {
	contract := newHandlerContract(t)
	const token = "capability-test-secret-0123456789abcdef"
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "bearer", BearerToken: token})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator,
		Media:         &routeTestMedia{},
		Preview:       routeTestPreview{},
		Projects:      routeTestProjects{},
		BatchExports:  &routeTestBatchExports{},
		Jobs:          &routeTestJobs{},
		ExportCapabilities: capabilityServiceFunc(func(context.Context, string) (exporter.Capabilities, error) {
			return exporter.Capabilities{Strategies: []exporter.StrategyCapability{{Strategy: "hybrid_smart_cut", Supported: true, Reasons: []string{}}}}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Shutdown)
	target := "/api/v2/export-capabilities/media/" + contractCapabilityMediaID

	request := handlerContractRequest(http.MethodGet, target, "", nil)
	contract.requireValidRequest(t, http.MethodGet, target, "", nil)
	response := contract.serve(t, server, http.MethodGet, target, "", nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s", response.Code, response.Body.String())
	}
	contract.requireValidResponse(t, request, response)
	requireContractErrorRequestID(t, response)

	headers := http.Header{"Authorization": []string{"Bearer " + token}}
	request = handlerContractRequest(http.MethodGet, target, "", headers)
	contract.requireValidRequest(t, http.MethodGet, target, "", headers)
	response = contract.serve(t, server, http.MethodGet, target, "", headers)
	if response.Code != http.StatusOK {
		t.Fatalf("authenticated status=%d body=%s", response.Code, response.Body.String())
	}
	contract.requireValidResponse(t, request, response)
}
