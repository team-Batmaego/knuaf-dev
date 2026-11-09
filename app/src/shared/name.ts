/**
 * 앱 이름. 주 프로세스·렌더러가 전부 여기서 가져간다.
 *
 * 보이는 이름만 바꾼다. 내부 이름은 데이터 폴더·헬퍼 번들·업데이트의 연속성을 위해 유지한다.
 *
 * `electron-builder.yml` 은 TS 를 읽지 못해 같은 문자열을 따로 적는다 —
 * 어긋나지 않도록 `e2e/invariants.spec.ts` 가 둘이 같은지 본다.
 */

/** 창 제목·앱 정보·화면·안내에 쓰는 표시 이름. */
export const APP_NAME = '창업논문 도우미'

/**
 * 파일 이름·번들 식별에 쓰는 ASCII 이름. `productName` 과 같아야 한다 —
 * 한글을 쓰면 헬퍼 번들이 "… 도우미 Helper.app" 이 되어 앱이 시작하자마자 죽는다.
 * 설치판의 userData 폴더 이름도 여기서 온다.
 */
export const APP_NAME_ASCII = 'knuaf-dev'
