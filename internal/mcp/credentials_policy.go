package mcp

import (
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// HasPermission reports whether the credential has one explicit operation grant.
func (c Credential) HasPermission(permission Permission) bool {
	return slices.Contains(c.Permissions, permission)
}

// ActiveAt checks status at the supplied instant.
func (c Credential) ActiveAt(now time.Time) bool {
	return c.activeAt(now.UTC()) == nil
}

// AllowsMedia checks the media scope without consulting filesystem paths.
func (c Credential) AllowsMedia(mediaID, rootID string) bool {
	return c.MediaScope.allows(mediaID, rootID)
}

// AllowsProjectSummary checks project scope for list/summary operations.
func (c Credential) AllowsProjectSummary(projectID string) bool {
	return validSafeIdentifier(projectID) && c.ProjectScope.allows(projectID)
}

// AllowsProject requires every media item in a full project to be in scope.
func (c Credential) AllowsProject(projectID string, media []MediaResource) bool {
	if !c.AllowsProjectSummary(projectID) || len(media) == 0 {
		return false
	}
	for _, item := range media {
		if !c.AllowsMedia(item.ID, item.RootID) {
			return false
		}
	}
	return true
}

// AllowsCreateProject requires project-write, media-read, and authorized media.
func (c Credential) AllowsCreateProject(media []MediaResource) bool {
	return c.HasPermission(PermissionProjectsRead) && c.HasPermission(PermissionProjectsWrite) && c.allowsAllMedia(media)
}

// AllowsUnattendedExport reports whether this credential can bypass app approval
// for an export; validation and all other limits still apply elsewhere.
func (c Credential) AllowsUnattendedExport() bool {
	return c.UnattendedExports && c.HasPermission(PermissionExportsRun)
}

// Allows evaluates one permission and all resource scope constraints. Job
// ownership is intentionally checked by the job service, not inferred here.
func (c Credential) Allows(permission Permission, resource Resource) bool {
	if !c.HasPermission(permission) {
		return false
	}
	switch permission {
	case PermissionMediaRead:
		return resource.MediaID == "" || c.AllowsMedia(resource.MediaID, resource.RootID)
	case PermissionPreviewsCreate:
		return c.AllowsMedia(resource.MediaID, resource.RootID)
	case PermissionDetectionRun:
		if !c.AllowsMedia(resource.MediaID, resource.RootID) {
			return false
		}
		if resource.ProjectID == "" {
			return true
		}
		return c.allowsProjectResource(resource)
	case PermissionProjectsRead:
		return resource.ProjectID == "" && resource.ProjectSummary || c.allowsProjectResource(resource)
	case PermissionProjectsWrite:
		if resource.ProjectID == "" {
			return c.AllowsCreateProject(resource.ProjectMedia)
		}
		return c.allowsProjectResource(resource)
	case PermissionExportsPrepare, PermissionExportsRun, PermissionExportsDownload:
		return c.allowsExportResource(resource)
	case PermissionJobsRead, PermissionJobsCancel:
		if resource.ProjectID != "" {
			return c.allowsProjectResource(resource)
		}
		if len(resource.ProjectMedia) > 0 {
			return c.allowsAllMedia(resource.ProjectMedia)
		}
		if resource.MediaID != "" {
			return c.AllowsMedia(resource.MediaID, resource.RootID)
		}
		return true
	default:
		return false
	}
}

func (c Credential) allowsExportResource(resource Resource) bool {
	if resource.ProjectID != "" {
		return c.allowsProjectResource(resource)
	}
	if len(resource.ProjectMedia) > 0 {
		return c.inMediaScope(resource.ProjectMedia)
	}
	return resource.MediaID != "" && c.AllowsMedia(resource.MediaID, resource.RootID)
}

func (c Credential) allowsProjectResource(resource Resource) bool {
	if resource.ProjectSummary && len(resource.ProjectMedia) == 0 {
		if !c.AllowsProjectSummary(resource.ProjectID) {
			return false
		}
		return resource.MediaID == "" || c.AllowsMedia(resource.MediaID, resource.RootID)
	}
	if !c.AllowsProject(resource.ProjectID, resource.ProjectMedia) {
		return false
	}
	return resource.MediaID == "" || c.AllowsMedia(resource.MediaID, resource.RootID)
}

func (c Credential) inMediaScope(media []MediaResource) bool {
	if len(media) == 0 {
		return false
	}
	for _, item := range media {
		if !c.AllowsMedia(item.ID, item.RootID) {
			return false
		}
	}
	return true
}

func (c Credential) allowsAllMedia(media []MediaResource) bool {
	if len(media) == 0 || !c.HasPermission(PermissionMediaRead) {
		return false
	}
	for _, item := range media {
		if !c.AllowsMedia(item.ID, item.RootID) {
			return false
		}
	}
	return true
}

func (scope MediaScope) allows(mediaID, rootID string) bool {
	if !validSafeIdentifier(mediaID) {
		return false
	}
	switch scope.Kind {
	case MediaScopeAll:
		return len(scope.RootIDs) == 0 && len(scope.MediaIDs) == 0
	case MediaScopeRoots:
		return validSafeIdentifier(rootID) && slices.Contains(scope.RootIDs, rootID)
	case MediaScopeMedia:
		return slices.Contains(scope.MediaIDs, mediaID)
	default:
		return false
	}
}

func (scope ProjectScope) allows(projectID string) bool {
	switch scope.Kind {
	case ProjectScopeAll:
		return len(scope.ProjectIDs) == 0
	case ProjectScopeSelected:
		return slices.Contains(scope.ProjectIDs, projectID)
	default:
		return false
	}
}

func (c Credential) activeAt(now time.Time) error {
	if c.RevokedAt != nil {
		return ErrCredentialRevoked
	}
	if c.ExpiresAt != nil && !c.ExpiresAt.After(now) {
		return ErrCredentialExpired
	}
	return nil
}

func normalizeCredentialInput(input CredentialInput, now time.Time) (CredentialInput, error) {
	if !utf8.ValidString(input.Name) || strings.TrimSpace(input.Name) == "" || utf8.RuneCountInString(input.Name) > credentialNameLimit || strings.IndexFunc(input.Name, unicode.IsControl) >= 0 {
		return CredentialInput{}, ErrCredentialInvalid
	}
	input.Name = strings.TrimSpace(input.Name)
	permissions, err := normalizePermissions(input.Permissions)
	if err != nil {
		return CredentialInput{}, err
	}
	mediaScope, err := normalizeMediaScope(input.MediaScope)
	if err != nil {
		return CredentialInput{}, err
	}
	projectScope, err := normalizeProjectScope(input.ProjectScope)
	if err != nil {
		return CredentialInput{}, err
	}
	if input.ExpiresAt == nil {
		if !input.AllowNonExpiring {
			return CredentialInput{}, ErrNonExpiringCredentialNeedsAck
		}
	} else {
		expires := input.ExpiresAt.UTC()
		if !expires.After(now) {
			return CredentialInput{}, ErrCredentialExpired
		}
		input.ExpiresAt = new(expires)
	}
	input.Permissions = permissions
	input.MediaScope = mediaScope
	input.ProjectScope = projectScope
	return input, nil
}

func normalizePermissions(permissions []Permission) ([]Permission, error) {
	result := make([]Permission, 0, len(permissions))
	for _, permission := range permissions {
		if !slices.Contains(knownPermissions, permission) || slices.Contains(result, permission) {
			return nil, ErrCredentialInvalid
		}
		result = append(result, permission)
	}
	slices.Sort(result)
	if slices.Contains(result, PermissionProjectsWrite) && !slices.Contains(result, PermissionProjectsRead) {
		return nil, ErrCredentialInvalid
	}
	return result, nil
}

func normalizeMediaScope(scope MediaScope) (MediaScope, error) {
	scope.RootIDs = slices.Clone(scope.RootIDs)
	scope.MediaIDs = slices.Clone(scope.MediaIDs)
	switch scope.Kind {
	case MediaScopeAll:
		if len(scope.RootIDs) != 0 || len(scope.MediaIDs) != 0 {
			return MediaScope{}, ErrCredentialInvalid
		}
	case MediaScopeRoots:
		if len(scope.RootIDs) == 0 || len(scope.RootIDs) > scopeIDLimit || len(scope.MediaIDs) != 0 || !validIDList(scope.RootIDs) {
			return MediaScope{}, ErrCredentialInvalid
		}
		slices.Sort(scope.RootIDs)
	case MediaScopeMedia:
		if len(scope.MediaIDs) == 0 || len(scope.MediaIDs) > scopeIDLimit || len(scope.RootIDs) != 0 || !validIDList(scope.MediaIDs) {
			return MediaScope{}, ErrCredentialInvalid
		}
		slices.Sort(scope.MediaIDs)
	default:
		return MediaScope{}, ErrCredentialInvalid
	}
	return scope, nil
}

func normalizeProjectScope(scope ProjectScope) (ProjectScope, error) {
	scope.ProjectIDs = slices.Clone(scope.ProjectIDs)
	switch scope.Kind {
	case ProjectScopeAll:
		if len(scope.ProjectIDs) != 0 {
			return ProjectScope{}, ErrCredentialInvalid
		}
	case ProjectScopeSelected:
		if len(scope.ProjectIDs) == 0 || len(scope.ProjectIDs) > scopeIDLimit || !validIDList(scope.ProjectIDs) {
			return ProjectScope{}, ErrCredentialInvalid
		}
		slices.Sort(scope.ProjectIDs)
	default:
		return ProjectScope{}, ErrCredentialInvalid
	}
	return scope, nil
}

func validIDList(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !validSafeIdentifier(value) {
			return false
		}
		if _, ok := seen[value]; ok {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}

func normalizeAuditInput(input AuditInput) (AuditInput, error) {
	if !validAuditAtom(input.Operation) || !validAuditAtom(input.Outcome) || len(input.ResourceIDs) > auditResourceLimit || input.JobID != "" && !validSafeIdentifier(input.JobID) {
		return AuditInput{}, ErrAuditInvalid
	}
	input.ResourceIDs = slices.Clone(input.ResourceIDs)
	if !validIDList(input.ResourceIDs) {
		return AuditInput{}, ErrAuditInvalid
	}
	// Preserve transport order so primary resource IDs remain first in audit records.
	return input, nil
}

func validAuditAtom(value string) bool {
	if value == "" || len(value) > auditAtomLimit {
		return false
	}
	for _, character := range value {
		if !validIdentifierCharacter(character, true) {
			return false
		}
	}
	return true
}

func validSafeIdentifier(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if !validIdentifierCharacter(character, false) {
			return false
		}
	}
	return true
}

func validIdentifierCharacter(character rune, colon bool) bool {
	return character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '_' || character == '-' || colon && character == ':'
}

func validCredentialID(value string) bool {
	return strings.HasPrefix(value, "c_") && validSafeIdentifier(value)
}
