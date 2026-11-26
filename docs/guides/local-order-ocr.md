# 本机截图识别

当前入口为日常收支“附件 / 图片”中每张图片旁的“提取信息”，不再从描述区域单独选图。完整流程、三种保留方式、隐私核对、业务号码及离线限制见[从附件提取交易信息](attachment-capture.md)。

图片及最多 6 页 PDF 可走同一本机识别流程；购物平台、支付账单与国内发票的明确标签覆盖见[平台订单与发票规则](capture-platform-rules.md)。发票的开票日期和号码是独立字段，不替代交易日期与订单号。

2026-11-26 起按新交互方案取消独立号码本机留存 UI；订单号和物流单号改为普通流水字段，按常规业务规则同步与备份。原图是否保存由附件保留方式决定，识别本身仍在本机。此前开发阶段的独立私密库不自动迁入普通流水，也不在本轮删除。

当前运行时采用 PaddleOCR.js 0.4.2、PP-OCRv5 mobile、OpenCV.js 4.10.0、ONNX Runtime Web 1.31.1 CPU WASM 与 zxing-wasm 3.1.7 reader；依赖与模型锁定、CSP 适配、准备方式见[脚本说明](../../scripts/README.md)。原生壳、手机实机内存和性能仍待专项验收。

## 开发与资源

Web 的 `predev`／`prebuild` 自动执行 `scripts/ocr/prepare-resources.mjs`。模型与运行时版本锁定在 `scripts/ocr/models.lock.json`，生成到忽略的 `apps/web/public/ocr/`，生产构建会生成带哈希的 OCR 清单并与普通应用缓存分开。

当前使用 PaddleOCR.js 0.4.2、PP-OCRv5 mobile 检测／识别模型、ONNX Runtime Web 1.31.1 CPU WASM、OpenCV.js 4.10.0 和 zxing-wasm 3.1.7 reader。码图 WASM 为 946,598 字节，固定大小和 SHA-256，随应用分发。分发许可位于 `apps/web/public/licenses/local-ocr/`。不使用 GPU 推理和云端 SDK；Worker 资源请求限制为同源公开 OCR 路径的 GET。

构建前对锁定源文件的 OpenCV JavaScript 包装做 CSP 适配，将四处字符串生成函数改为普通闭包，不修改嵌入的 WASM，不增加 `unsafe-eval`。开发与生产使用同一适配，详见 `scripts/ocr/opencv-csp.mjs`。

解析测试包含 100 组确定性的合成 OCR 行数据，另有真实引擎读取浏览器生成中文图片的端到端测试；这些数据不等同于 100 张真实订单截图准确率验收。后续需使用获授权、脱敏的真实平台样本继续验证。
