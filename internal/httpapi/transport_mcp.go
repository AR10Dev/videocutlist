package httpapi

import (
	"fmt"

	"videocutlist/internal/export"
	"videocutlist/internal/httpapi/transport"
	"videocutlist/internal/mcp"
	"videocutlist/internal/projects/model"
)

func mcpMediaScopeToTransport(scope mcp.MediaScope) transport.MCPMediaScope {
	mapped := transport.MCPMediaScope{Kind: transport.MCPMediaScopeKind(scope.Kind)}
	if len(scope.RootIDs) > 0 {
		rootIDs := append([]string(nil), scope.RootIDs...)
		mapped.RootIds = &rootIDs
	}
	if len(scope.MediaIDs) > 0 {
		mediaIDs := append([]string(nil), scope.MediaIDs...)
		mapped.MediaIds = &mediaIDs
	}
	return mapped
}

func mcpProjectScopeToTransport(scope mcp.ProjectScope) transport.MCPProjectScope {
	mapped := transport.MCPProjectScope{Kind: transport.MCPProjectScopeKind(scope.Kind)}
	if len(scope.ProjectIDs) > 0 {
		projectIDs := append([]string(nil), scope.ProjectIDs...)
		mapped.ProjectIds = &projectIDs
	}
	return mapped
}

func mcpPermissionsToTransport(permissions []mcp.Permission) []string {
	if permissions == nil {
		return nil
	}
	mapped := make([]string, len(permissions))
	for index, permission := range permissions {
		mapped[index] = string(permission)
	}
	return mapped
}

func mcpCredentialToTransport(credential mcp.Credential, status string) transport.MCPCredential {
	mappedStatus := transport.MCPCredentialStatus(status)
	return transport.MCPCredential{
		CreatedAt: credential.CreatedAt, ExpiresAt: credential.ExpiresAt,
		Id: credential.ID, LastUsedAt: credential.LastUsedAt,
		MediaScope: mcpMediaScopeToTransport(credential.MediaScope), Name: credential.Name,
		Permissions:  mcpPermissionsToTransport(credential.Permissions),
		ProjectScope: mcpProjectScopeToTransport(credential.ProjectScope), RevokedAt: credential.RevokedAt,
		Status: &mappedStatus, TokenIdentifier: credential.TokenIdentifier,
		UnattendedExports: credential.UnattendedExports,
	}
}

func mcpCreatedCredentialToTransport(created mcp.CreatedCredential) transport.MCPCredentialCreated {
	credential := created.Credential
	return transport.MCPCredentialCreated{
		CreatedAt: credential.CreatedAt, ExpiresAt: credential.ExpiresAt,
		Id: credential.ID, LastUsedAt: credential.LastUsedAt,
		MediaScope: mcpMediaScopeToTransport(credential.MediaScope), Name: credential.Name,
		Permissions:  mcpPermissionsToTransport(credential.Permissions),
		ProjectScope: mcpProjectScopeToTransport(credential.ProjectScope), RevokedAt: credential.RevokedAt,
		Secret: created.Secret, TokenIdentifier: credential.TokenIdentifier,
		UnattendedExports: credential.UnattendedExports,
	}
}

func mcpExportProposalToTransport(proposal mcp.ExportProposal) (transport.ExportProposal, error) {
	projectRevision, ok := projectRevisionToTransport(proposal.ProjectRevision)
	if !ok {
		return transport.ExportProposal{}, fmt.Errorf("export proposal revision exceeds transport integer range")
	}
	findings := exportFindingsToTransport(proposal.Findings)
	snapshots, err := exportSnapshotsToTransport(proposal.Snapshots)
	if err != nil {
		return transport.ExportProposal{}, err
	}
	mapped := transport.ExportProposal{
		Accuracy: transport.ExportProposalAccuracy(proposal.Accuracy), Allowed: proposal.Allowed,
		ApprovedAt: proposal.ApprovedAt, CreatedAt: proposal.CreatedAt,
		CredentialId: proposal.CredentialID, DestinationId: proposal.DestinationID,
		ExpiresAt: proposal.ExpiresAt, Findings: findings, Id: proposal.ID,
		ProjectRevision: projectRevision, RequiresReencoding: proposal.RequiresReencoding,
		Snapshots: snapshots,
	}
	if proposal.MediaID != "" {
		mapped.MediaId = new(proposal.MediaID)
	}
	if proposal.ProjectID != "" {
		mapped.ProjectId = new(proposal.ProjectID)
	}
	return mapped, nil
}

func mcpExportProposalsToTransport(proposals []mcp.ExportProposal) ([]transport.ExportProposal, error) {
	if proposals == nil {
		return nil, nil
	}
	mapped := make([]transport.ExportProposal, len(proposals))
	for index, proposal := range proposals {
		value, err := mcpExportProposalToTransport(proposal)
		if err != nil {
			return nil, err
		}
		mapped[index] = value
	}
	return mapped, nil
}

func exportFindingsToTransport(findings []export.Finding) []transport.ExportFinding {
	if findings == nil {
		return nil
	}
	mapped := make([]transport.ExportFinding, len(findings))
	for index, finding := range findings {
		mapped[index] = transport.ExportFinding{
			Severity: transport.ExportFindingSeverity(finding.Severity), Code: finding.Code,
			Message: finding.Message, StreamIndex: finding.StreamIndex,
		}
	}
	return mapped
}

func exportSnapshotsToTransport(snapshots []export.ExportSnapshot) ([]transport.ExportSnapshot, error) {
	if snapshots == nil {
		return nil, nil
	}
	mapped := make([]transport.ExportSnapshot, len(snapshots))
	for index, snapshot := range snapshots {
		projectRevision, ok := projectRevisionToTransport(snapshot.ProjectRevision)
		if !ok {
			return nil, fmt.Errorf("export snapshot revision exceeds transport integer range")
		}
		item, ok := proposalItemToTransport(snapshot.Item)
		if !ok {
			return nil, fmt.Errorf("export snapshot item exceeds transport integer range")
		}
		sourceSize, ok := projectRevisionToTransport(snapshot.Source.SizeBytes)
		if !ok {
			return nil, fmt.Errorf("export source size exceeds transport integer range")
		}
		sourceDuration, ok := projectRevisionToTransport(snapshot.Source.DurationMS)
		if !ok {
			return nil, fmt.Errorf("export source duration exceeds transport integer range")
		}
		source := transport.SourceSnapshot{
			DurationMs: sourceDuration, Etag: snapshot.Source.ETag,
			MediaId: snapshot.Source.MediaID, SizeBytes: sourceSize,
		}
		if snapshot.Source.RootID != "" {
			source.RootId = new(snapshot.Source.RootID)
		}
		mapped[index] = transport.ExportSnapshot{
			Item: item, MediaLabel: snapshot.MediaLabel,
			ProjectRevision: projectRevision, Source: source,
		}
	}
	return mapped, nil
}

func proposalItemToTransport(item model.ProjectItem) (transport.ProjectItem, bool) {
	segments, ok := projectSegmentsToTransport(item.Segments)
	if !ok {
		return transport.ProjectItem{}, false
	}
	mapped := transport.ProjectItem{Id: item.ID, MediaId: item.MediaID, Segments: segments}
	if item.EditorState != nil {
		playhead, ok := projectRevisionToTransport(item.EditorState.PlayheadMS)
		if !ok {
			return transport.ProjectItem{}, false
		}
		mapped.EditorState = &transport.UIState{PlayheadMs: playhead, Zoom: item.EditorState.Zoom, Muted: item.EditorState.Muted}
	}
	if !emptyProjectExportOptions(item.ExportOptions) {
		exportOptions := projectExportOptionsToTransport(item.ExportOptions)
		if len(item.ExportOptions.StreamIndexes) == 0 {
			exportOptions.StreamIndexes = nil
		}
		mapped.ExportOptions = *exportOptions
	}
	return mapped, true
}
