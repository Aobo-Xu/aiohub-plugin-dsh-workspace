# Platform support

The first DSH Coding Workspace release supports Windows x64 (`win32-x64`) only.
The release ZIP contains a single Windows manifest executable map and no
preview artifact.

Linux x64 (including `.deb` and `.AppImage`), macOS arm64, Linux arm64, and
Flatpak are unsupported in this release. They require a separately approved
change with native artifacts and native gates; users must not infer support
from an unbuilt runtime-lock entry.

Development uses the local AIO Hub plugin junction. Release verification must
instead install the final ZIP through the production AIO installer.
