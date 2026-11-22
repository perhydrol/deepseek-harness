# Download proxy integration test

English | [中文](proxy.test.zh.md)

[proxy.test.js](proxy.test.js) exercises authenticated binary and ZIP transfers through the public-auth proxy. Its workspace resolver returns a directory different from the session header, and the file adapters verify that both transfers use the resolved scope. The fixture allocates a private temporary directory and an OS-assigned loopback port. Cleanup closes proxy connections and the Host server before deleting temporary state.
