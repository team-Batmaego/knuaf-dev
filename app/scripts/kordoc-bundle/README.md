# kordoc 덩어리 (OCR 뺀 판) — 만들기·형식 명세

학생 PC 에 Node 가 없어도 kordoc 이 돌아야 한다. 그래서 앱은 **kordoc 4.17.1 과 그 실행 의존성만**
담은 tgz 를 내려받아 풀고, 앱 exe 를 `ELECTRON_RUN_AS_NODE=1` 로 띄워
`node_modules/kordoc/dist/cli.js`(CLI) · `dist/mcp.js`(MCP) 를 자식 프로세스로 돌린다(11-13 확정).

이 폴더는 **그 tgz 를 다시 만들 수 있게** 하는 스크립트다. 손으로 만든 실험실 산출물
(`2026-11-10-kordoc-node-runtime/lab`)을 저장소 안에서 재현하는 것이 목적이다.

| 파일 | 역할 |
|---|---|
| `tar.mjs` | 결정적 tar·gzip 쓰기/읽기(형식 정본). 의존성 없음 |
| `bundle.mjs` | 설치 → 정리 → 압축 → 계약 검사 → 명세. CLI 진입점 |
| `../tests/kordoc-bundle.test.mjs` | 네트워크 없이 도는 형식·계약 시험 |

## 쓰는 법

```bash
# 세 대상 전부 (기본 산출물: app/out/kordoc-bundle/)
node app/scripts/kordoc-bundle/bundle.mjs

# 한 대상만
node app/scripts/kordoc-bundle/bundle.mjs --target darwin-arm64

# 만든 것 다시 검사(명세 대조 + tgz 내부 계약)
node app/scripts/kordoc-bundle/bundle.mjs --verify
```

`--out <폴더>` 로 산출물 위치를 바꾸고, `--force` 로 같은 이름 덮어쓰기를 허용한다.
설치에는 `pnpm` 이 필요하고 네트워크를 쓴다(CI·릴리스 담당만 실행).

pnpm 은 PATH 에서 찾아 **첫 바이트를 보고** 띄운다: 셔뱅 있음·ELF·Mach-O·PE 면 그대로 실행하고,
shebang 없는 텍스트 스크립트면 POSIX 는 `sh <경로> …`, 윈도는 `cmd.exe /d /s /c` 로 감싼다.
이유: pnpm 11 이 까는 전역 셔틀(`~/.npm-global/bin/pnpm`)이 shebang 없는 `sh` 스크립트라
`spawn` 이 `ENOEXEC` 으로 죽는다(11-15 실측). 인자는 배열로 넘기므로 셸 인용 문제가 없다.

## 계약 — 이 스크립트가 지키는 것

1. **판 고정.** `kordoc@4.17.1`, `pdfjs-dist@4.10.38`, `sharp@0.35.5`, `@hyzyla/pdfium@2.1.13`,
   `@napi-rs/canvas@0.1.100`(+ 대상별 플랫폼 패키지).
   뜨는 대로 깔지 않는다. `cli.js` 해시는 `f755b0bc…97a5c`(11-10 실측, 맥·윈도 동일)로 못박고
   검사 단계에서 대조한다.
   `@napi-rs/canvas` 를 직접 넣는 이유: `pdfjs-dist` 가 페이지 렌더에 이걸 선택 의존성으로 쓰는데
   (`build/pdf.mjs` 의 `require("@napi-rs/canvas")`), 우리는 `--no-optional` 로 깔기 때문에
   자동 유입이 막힌다. 빼면 PDF→이미지 렌더가 조용히 죽는다(11-10 lab 이 canvas ABI 로드까지 확인).
2. **대상 고정.** `darwin-arm64` · `darwin-x64` · `win32-x64`.
   대상마다 그 판의 네이티브 패키지만 담는다. 다른 판 패키지가 하나라도 섞이면 검사가 실패한다
   (11-10 실측: 섞이면 윈도 설치본이 깨진다).
3. **OCR 제외.** `onnxruntime-node` · `@huggingface/*` 를 담지 않는다.
   대신 이미지 스캔 PDF 는 텍스트가 0자로 나온다 → 앱이 그 경고를 받으면 `ocr:true` 로 재시도하는
   경로를 따로 둔다(덩어리 자체는 OCR 을 못 한다).
4. **재현 가능.** 같은 입력이면 같은 tgz sha256. 아래 "형식"이 그 근거다.
   설치 뒤 `node_modules` 루트의 **점(.) 항목을 전부 지운다** — pnpm 이 남기는
   `.pnpm-workspace-state-v1.json` 에 임시 폴더 절대경로와 나노초 시각이 박혀 실행마다 해시가
   갈리기 때문이다(11-15 실측). npm 패키지 이름은 점으로 시작할 수 없으므로 점 항목은 전부
   도구 상태 파일이고, 런타임 해석에 쓰이지 않는다.
5. **심볼릭 링크 0개.** 윈도 설치본은 링크 생성에 관리자 권한이 필요하고, 복사 단계가 링크를
   보존한다는 보장이 없다. pnpm 은 `--config.node-linker=hoisted` 로 깐다(`.pnpm/` 링크 391개 회피).
   링크가 남아 있으면 만드는 단계에서 즉시 실패한다.

## 형식 — tgz 안에서 기계가 기대는 것

### tar (ustar, `tar.mjs`)

| 항목 | 값 |
|---|---|
| 담는 것 | `node_modules/**`, `package.json`, (있으면) `pnpm-lock.yaml`. 그 밖의 파일은 담지 않는다 |
| 항목 순서 | 경로 **UTF-8 바이트 오름차순**. 디렉터리 항목도 넣는다 |
| `mtime` | 0 (시각을 싣지 않는다) |
| `uid`·`gid` | 0 |
| `uname`·`gname` | 빈 문자열 |
| `mode` | 0644 (파일) / 0755 (디렉터리) |
| 이름 칸 | `name` 100B + `prefix` 155B. 255B 초과 경로만 pax `x` 헤더 |
| 링크·특수 파일 | 담지 않는다 — 만나면 실패 |
| 끝 | 0 블록 2개 |

읽는 쪽은 헤더 체크섬을 검증하고, 항목 이름이 절대경로·드라이브 문자(`C:`)·`..`·역슬래시·NUL 이면
**던진다**. 풀기 전에 이 검사를 통과해야 설치 폴더 밖으로 나가지 않는다.

### gzip (직접 조립)

호스트 `tar -czf` 를 쓰지 않는 이유: 헤더에 mtime·OS 바이트가 들어가 기계마다 바이트가 달라진다.
그래서 헤더를 손으로 쓴다.

| 바이트 | 값 |
|---|---|
| 매직·방식 | `1f 8b 08` |
| flags | 0 (이름·주석 없음) |
| MTIME | 0 |
| XFL | 2 (최대 압축) |
| OS | 255 (unknown) |
| 본문 | `deflateRaw`, level 9 |
| 꼬리 | CRC32(원본) + ISIZE(원본 길이) — 우리가 계산 |

**남는 비결정성은 하나뿐이다**: deflate 출력은 zlib 판에 따라 달라질 수 있다. 그래서 명세에
`tooling.node`·`tooling.zlib`·`tooling.pnpm` 을 적는다. 앱은 tgz 해시가 아니라 **명세에 적힌 해시**를
요구하므로, 만든 사람과 받는 사람 사이 계약은 그대로 성립한다. 같은 도구 판에서 다시 만들면
바이트가 같다.

### 명세 `kordoc-bundle.json`

```json
{
  "formatVersion": 1,
  "kordocVersion": "4.17.1",
  "ocr": false,
  "cli": { "path": "node_modules/kordoc/dist/cli.js", "sha256": "f755b0bc…" },
  "mcp": { "path": "node_modules/kordoc/dist/mcp.js" },
  "tooling": { "node": "v22.x", "zlib": "1.3.x", "pnpm": "10.x" },
  "targets": {
    "darwin-arm64": {
      "target": "darwin-arm64",
      "file": "kordoc-darwin-arm64.tgz",
      "bytes": 0,
      "sha256": "…",
      "unpackedBytes": 0,
      "files": 0,
      "packages": { "kordoc": "4.17.1", "…": "…" },
      "cli": { "path": "node_modules/kordoc/dist/cli.js", "sha256": "…" },
      "kordocVersion": "4.17.1",
      "mcp": { "path": "node_modules/kordoc/dist/mcp.js", "sha256": "…" }
    }
  }
}
```

- `targets` 는 대상 이름 오름차순. 부분 빌드(`--target` 하나)는 다른 대상 기록을 **지우지 않는다**.
- `bytes`·`sha256`·`unpackedBytes`·`files` 는 산출물에서 계산한 실측값이다(손으로 적지 않는다).
- 앱은 내려받은 tgz 의 `bytes`·`sha256` 을 대조하고, 푼 뒤 `cli.sha256` 을 다시 확인한다.
- 명세에는 **계약 필드만** 들어간다. 빌드 진단(`workDir`·`ignoredBuilds`·항목 수)은 화면·로그에만
  나간다 — 작업 폴더 절대경로가 명세에 새면 기계마다 다른 파일이 되고 개인 경로가 저장소에 남는다.

## 검사(`verifyTarGz`)가 잡는 것

- `kordoc` 판이 `4.17.1` 이 아니다 / `node_modules/kordoc/package.json` 이 없다
- `dist/cli.js` 가 없다 / 해시가 계약값과 다르다 / `dist/mcp.js` 가 없다
- OCR 패키지(`onnxruntime*`, `@huggingface/*`)가 들어 있다
- 필수 패키지가 빠졌다 / 판이 다르다
- **다른 대상의** 플랫폼 패키지가 섞였다
- 풀린 크기 > 320 MiB, 항목 수 > 60,000 (OCR 판을 실수로 담았을 때 걸리는 상한)
- tar 항목이 링크·특수 파일·이상 경로다

## 실측값

이 스크립트로 만든 결과(11-15, node v24.22.3 · zlib 1.3.2.1-motley · pnpm 12.18.0):

| 대상 | tgz | 풀림 | 파일 수 | sha256 |
|---|---|---|---|---|
| darwin-arm64 | 40.42 MiB | 115.42 MiB | 4390 | `02e57a8844694db1335eee5b5df7e1956a6fd7d790d266443f99d5b079aed804` |
| darwin-x64 | 41.95 MiB | 122.43 MiB | 4390 | `a65ef4f32cc55f4d15af6f4dcf186e9cb034f85333bb1c6ab9e1ca759281be91` |
| win32-x64 | 43.26 MiB | 127.57 MiB | 4388 | `385b62644f6dd13fc0b8fcc35aa235aa4f0601600390a46cbc8b29ab601b78f7` |

세 대상 모두 두 번씩 빌드해 같은 해시가 나왔다(재현 확인). 값은 만든 도구 판에 묶인다 —
위 `tooling` 이 다르면 해시도 달라질 수 있다.

11-10 실험실(`lab/make-payload.sh`, OCR 제외) 기준선: darwin-arm64 40.0 MiB / 115.5 MB,
win32-x64 43.8 MiB / 127.7 MB — 같은 대역이다.

`cli.js` sha256 은 맥·윈도 tarball 이 같다: `f755b0bc4ee860622066f30200e188481501d25969e2e38bcf79e9d2b4897a5c`
(`mcp.js` 는 `ed675ba09018de9149414526d0a890aaad4c94410a392c68cb1dae0d241ba456`).

## 경계

- 설치 폴더는 시스템 임시 폴더에 만들고 끝나면 지운다(`--keep-work` 로 남길 수 있다).
  지울 때 폴더 이름이 `kordoc-bundle-` 로 시작하는지 확인한다 — 엉뚱한 경로 삭제 방지.
- `app/out/` 은 빌드 산출물이다(추적하지 않는다). tgz 를 저장소에 커밋하지 않는다.
- 윈도 실기기 검증은 아직 없다(COM·설치본 경로). 이 스크립트가 보장하는 것은 **tgz 내용과 형식**까지다.
