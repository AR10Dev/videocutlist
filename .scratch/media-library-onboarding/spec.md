# Media library onboarding

## Problem

A first-time user sees an empty editor with no explanation of how VideoCutlist discovers media. The current browser contract intentionally does not expose original media filesystem paths, so the UI cannot safely implement an unrestricted local folder picker.

## Outcome

A user can tell whether a media library has been configured, whether it is scanning, whether it contains supported media, and what action fixes an empty or failed library. Once media exists, the user can browse a safe virtual folder tree and select a video before editor-only controls appear.

## Non-goals

- Do not accept arbitrary filesystem paths from browsers.
- Do not return original media filesystem paths.
- Do not add browser upload of original media in this work.
- Do not expose export, project, or detection controls as the primary first-run task.

## Constraints

- The container/server owns media-root configuration.
- API responses must use opaque media IDs and safe display labels only.
- The UI must distinguish unconfigured, scanning, empty, and failed states.
- Folder labels and IDs need a security review before becoming API data.
