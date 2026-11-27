# kordoc 덩어리 (OCR 뺀 판) — 만들기·형식 명세

학생 PC 에 Node 가 없어도 kordoc 이 돌아야 한다. 그래서 앱은 **kordoc 4.25.3 과 그 실행 의존성만**
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
shebang 없는 텍스트 스크립트면 POSIX 는 `sh <경로> …`, 윈도는 `cmd.exe /d /s /v:off /c "…"` 로 감싼다.
이유: pnpm 11 이 까는 전역 셔틀(`~/.npm-global/bin/pnpm`)이 shebang 없는 `sh` 스크립트라
`spawn` 이 `ENOEXEC` 으로 죽는다(11-15 실측).

- **pnpm 판 하한은 없다.** 11-15 에 설치 전에 죽던 원인은 pnpm 판이 아니라 `--no-frozen-lockfile`
  플래그였다(pnpm 10.32·11.25 가 `Unknown option` 으로 거절). 그 플래그를 빼서 원인을 없앴고,
  지금은 설치 전에 `pnpm --version` 이 도는지만 확인한다(못 도는 실행기를 몇 분 뒤에 만나지 않게).
  pnpm 10·11 에서 이 스크립트 전체가 도는지는 **아직 실측이 없다** — 릴리스는 12.18.0 실측.
- 윈도 인용은 우리가 한다. `cmd /c` 뒤 문자열에는 `%` 를 **큰따옴표로도** 막을 수 없다(환경변수로
  먼저 확장된다). 그래서 `%` 가 든 인자는 조용히 틀리는 대신 **거절**한다. `!` 는 `/v:off` 로 끄고
  같은 이유로 감싼다. 그 밖의 문자는 cmd 문법 문자일 때만 감싼다(`--os=win32` 를 감싸면 pnpm 이
  플래그를 못 읽는다).
- 인자는 POSIX·윈도 모두 배열로 넘긴다(윈도만 `windowsVerbatimArguments` + 우리 인용).

## 계약 — 이 스크립트가 지키는 것

1. **판 고정.** `kordoc@4.25.3`, `sharp@0.35.5`, `@hyzyla/pdfium@2.1.13`, `zxing-wasm@3.1.6`
   (+ 대상별 플랫폼 패키지). 뜨는 대로 깔지 않는다. `cli.js` 해시는 4.25.3 첫 빌드 뒤 채운다 —
   그때까지 `TODO-BUILD` 자리표시이고 verify 는 이 자리표시가 남아 있으면 실패한다.
   (4.17.1 판은 `pdfjs-dist@4.10.38`·`@napi-rs/canvas@0.1.100` 도 고정했고 `cli.js` 는 `f755b0bc…97a5c` 였다.)
   - **뺀 것: `pdfjs-dist`·`@napi-rs/canvas`** — 4.25.3 의존성(dependencies·optionalDependencies)에 둘 다 없다
     (npm view 실측). 4.17.1 은 pdfjs-dist 가 페이지 렌더에 canvas 래퍼를 선택 의존성으로 요구해서
     `--no-optional` 설치에서 직접 넣었으나, 이제 요구하는 쪽이 없다.
   - **더한 것: `zxing-wasm`** — 4.25.3 의 새 optional 의존성. `--no-optional` 설치라 자동 유입이 막힌다.
   - **미확정(TODO-BUILD):** 4.25.3 의 PDF 렌더 경로가 무엇인지, `zxing-wasm` 이 필수인지, peer 셋
     (`@rhwp/core`·`libheif-js`·`puppeteer-core`, 모두 optional peer)을 넣어야 하는지는
     `npm pack kordoc@4.25.3` 의 dist 를 본 뒤 정한다. 지금은 넣지 않는다(앱이 쓰는 hwpx 생성·읽기 경로에 불필요하다고 *가정* — 미실측).
2. **대상 고정.** `darwin-arm64` · `darwin-x64` · `win32-x64`.
   대상마다 그 판의 네이티브 패키지만 담는다. 다른 판 패키지가 하나라도 섞이면 검사가 실패한다
   (11-10 실측: 섞이면 윈도 설치본이 깨진다).
3. **OCR 제외.** `onnxruntime-node` · `@huggingface/*`(4.25.3 은 `@huggingface/tokenizers`) 를 담지 않는다.
   대신 이미지 스캔 PDF 는 텍스트가 0자로 나온다 → 앱이 그 경고를 받으면 `ocr:true` 로 재시도하는
   경로를 따로 둔다(덩어리 자체는 OCR 을 못 한다).
4. **tgz 결정성.** **같은 설치 트리 → 같은 tgz sha256.** 아래 "형식"이 그 근거다.
   설치 자체(어떤 트리가 깔리나)는 여기서 보장하지 않는다 — kordoc 의 전이 의존성은 범위로 적혀
   있어 registry 해석이 바뀌면 같은 도구 판에서도 다른 트리가 나올 수 있다(11-15 Roh 검토 I-03).
   릴리스는 이 스크립트가 낸 명세의 해시를 계약으로 쓰므로 배포 경로는 그대로 성립한다.
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
  "kordocVersion": "4.25.3",
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
      "packages": { "kordoc": "4.25.3", "…": "…" },
      "cli": { "path": "node_modules/kordoc/dist/cli.js", "sha256": "…" },
      "kordocVersion": "4.25.3",
      "mcp": { "path": "node_modules/kordoc/dist/mcp.js", "sha256": "…" },
      "tooling": { "node": "v22.x", "zlib": "1.3.x", "pnpm": "12.x" }
    }
  }
}
```

- `targets` 는 대상 이름 오름차순. 부분 빌드(`--target` 하나)는 다른 대상 기록을 **지우지 않는다**.
- `tooling` 은 **대상마다** 따로 적는다. 부분 빌드에서 한 대상만 다시 만들면 그 대상의 `tooling` 만
  새 판으로 바뀌고, 나머지는 만들 당시의 판으로 남는다 — 최상위 `tooling` 만 갱신하면 "이 tgz 를
  어떤 도구로 만들었나"가 거짓이 된다(11-15 Roh 검토 R-01). 최상위 값은 이번 실행의 참고값이다.
- `bytes`·`sha256`·`unpackedBytes`·`files` 는 산출물에서 계산한 실측값이다(손으로 적지 않는다).
- 앱은 내려받은 tgz 의 `bytes`·`sha256` 을 대조하고, 푼 뒤 `cli.sha256` 을 다시 확인한다.
- 명세에는 **계약 필드만** 들어간다. 빌드 진단(`workDir`·`ignoredBuilds`·항목 수)은 화면·로그에만
  나간다 — 작업 폴더 절대경로가 명세에 새면 기계마다 다른 파일이 되고 개인 경로가 저장소에 남는다.

## 검사(`verifyTarGz`)가 잡는 것

- `kordoc` 판이 `4.25.3` 이 아니다 / `node_modules/kordoc/package.json` 이 없다
- `dist/cli.js` 가 없다 / 해시가 계약값과 다르다(자리표시 `TODO-BUILD` 면 실제 digest 를 알려 주며 실패) / `dist/mcp.js` 가 없다
- OCR 패키지(`onnxruntime*`, `@huggingface/*`)가 들어 있다
- 필수 패키지가 빠졌다 / 판이 다르다
- **다른 대상의** 플랫폼 패키지가 섞였다
- 풀린 크기 > 320 MiB, 항목 수 > 60,000 (OCR 판을 실수로 담았을 때 걸리는 상한)
- tar 항목이 링크·특수 파일·이상 경로다

## 실측값

**4.25.3 판은 아직 만들지 않았다 — TODO-BUILD.** 만든 뒤 아래 표(대상별 tgz·풀림·파일 수·sha256)와
`cli.js`·`mcp.js` sha256 을 실측값으로 채운다. 지어 쓰지 않는다.

참고(이전 4.17.1 판, 11-15, node v24.22.3 · zlib 1.3.2.1-motley · pnpm 12.18.0): darwin-arm64 40.42 MiB / 풀림 115.42 MiB,
darwin-x64 41.95 / 122.43, win32-x64 43.26 / 127.57 MiB. 4.25.3 판은 의존성 축이 달라 이 값과 다를 수 있다.

## 경계

- 설치 폴더는 시스템 임시 폴더에 만들고 끝나면 지운다(`--keep-work` 로 남길 수 있다).
  지울 때 폴더 이름이 `kordoc-bundle-` 로 시작하는지 확인한다 — 엉뚱한 경로 삭제 방지.
- `app/out/` 은 빌드 산출물이다(추적하지 않는다). tgz 를 저장소에 커밋하지 않는다.
- 윈도 실기기 검증은 아직 없다(COM·설치본 경로). 이 스크립트가 보장하는 것은 **tgz 내용과 형식**까지다.
