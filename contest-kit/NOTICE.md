# qa-ui 이식 출처와 고지

검증 흐름과 결과 필드의 출처는 [Hanbeeen/codex-harness-hb의 qa-ui](https://github.com/Hanbeeen/codex-harness-hb/blob/ae43f456e45b9c1d1800b0f5eaba00f80a0123e1/codex-home/agents/qa-ui.toml)임. 원본 commit은 ae43f456e45b9c1d1800b0f5eaba00f80a0123e1임.

모델 고정, 역할 내부 권한/MCP 설정과 전체 QA 엔진 의존을 제거하고 본인 앱 범위, 실패 전용 캡처와 미수집 보고를 연결했음. MCP는 Model Context Protocol(모델과 도구 연결 규약)임. 원본 QA 엔진의 전체 출력 수집과 호환을 검증한 것은 아님.

원본 [LICENSE](https://github.com/Hanbeeen/codex-harness-hb/blob/ae43f456e45b9c1d1800b0f5eaba00f80a0123e1/LICENSE)의 고지는 아래와 같음. 이 파일이 다른 외부 스킬과 플러그인의 라이선스까지 대신하지 않음.

## 원본 MIT 고지

MIT License

Copyright (c) 2026 Hanbeeen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
