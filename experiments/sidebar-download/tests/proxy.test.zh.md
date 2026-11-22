# 下载代理集成测试

[English](proxy.test.md) | 中文

[proxy.test.js](proxy.test.js) 通过 public-auth 代理验证已登录的二进制及 ZIP 传输。工作区解析器返回与会话头不同的目录，文件适配器验证两种传输使用解析后的范围。fixture 分配私有临时目录和操作系统分配的回环端口。清理先关闭代理连接与 Host 服务，再删除临时状态。
