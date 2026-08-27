# Media-library onboarding research

## What comparable editors do

- [LosslessCut](https://github.com/mifi/lossless-cut/blob/d8eccdf4/src/renderer/src/NoFileLoaded.tsx) makes its empty state an actionable drop zone. Its [open flow](https://github.com/mifi/lossless-cut/blob/d8eccdf4/src/renderer/src/App.tsx) accepts files and folders, then recursively expands a selected folder before loading media. Its [menu](https://github.com/mifi/lossless-cut/blob/d8eccdf4/src/main/menu.ts) keeps "Open" and "Open folder" separate.
- [Kdenlive's Project Bin](https://docs.kdenlive.org/en/project_and_asset_management/project_bin.html) is project-scoped. Its [Add Clip or Folder](https://docs.kdenlive.org/en/project_and_asset_management/project_bin/clips.html) action is discoverable in an empty bin. Its [folders](https://docs.kdenlive.org/en/project_and_asset_management/project_bin/project_bin_use_folders.html) are virtual project bins, which can nest without mirroring source paths.
- DaVinci Resolve describes the [Media Pool](https://documents.blackmagicdesign.com/UserManuals/DaVinci-Resolve-20-Beginners-Guide.pdf) as the place to import and organize project clips. Its optional filesystem-folder synchronization is documented in the [Resolve 19.1 release guide](https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_19_1_New_Features_Guide.pdf?_v=). It is not a baseline feature for VideoCutlist.

## Direction for VideoCutlist

Use the Kdenlive model for persistent organization and LosslessCut's clear empty-state action. The first screen needs one primary "Add media" action and an optional "Add folder" action. Media-dependent work stays disabled until indexing validates at least one item.

VideoCutlist differs from desktop applications. It must not copy their native-path APIs. The browser gets opaque media and virtual-folder IDs plus safe display metadata. The server resolves configured roots, walks folders, validates files, resolves symlinks, bounds work, and reports progress without returning source paths.

Do not add automatic filesystem synchronization now. It needs watch permissions, lifecycle rules, and stronger path-leakage review.
