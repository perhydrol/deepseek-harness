# Download Host entry

English | [中文](index.zh.md)

[index.ts](index.ts) owns HTTP admission, preparation tickets, and request cleanup. Every POST resolves its session through `workspaceFiles.scopeOf(sessionId, signal)` and passes the returned scope to file operations. The workspace service owns live and persisted directory selection, so listing and preparation follow workspace moves. An unknown session returns 404. Scope resolution receives request cancellation.

Prepared tickets retain the bytes selected during preparation. Consuming a ticket transfers those bytes even if the session's workspace subsequently moves. Plugin disposal aborts active requests and awaits temporary-file cleanup.
