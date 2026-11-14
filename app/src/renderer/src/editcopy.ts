/**
 * 뷰어 직접 수정 — 문구 (설계 §3-1·§3-2·§3-3·§3-4, §4-5-6).
 *
 * `copy.ts` 는 다른 워커 차례라 이 묶음에서 건드리지 않는다(ORDER-IMPL-2A ③). 그래서 이
 * 화면의 문구는 여기 모아 둔다 — B 묶음이 `copy.ts` 로 옮길 때 키 이름만 맞추면 된다.
 * 키 모양은 `copy.ts` 와 같다(평평한 객체, 값은 문자열 또는 함수).
 */
export const EDIT = {
  /** 막대 — `고쳐 달라기`·`복사` 옆에 붙는 단추(§3-1). */
  button: '직접 수정',
  /** 단추가 눌리지 않을 때의 이유 — 숨기지 않고 흐리게 둔다(§3-1 ⑤). */
  blocked: {
    agentBusy: '도우미가 쓰는 중이에요',
    oneBlock: '한 문단 안에서 골라 주세요',
    needsQuote: '표·서식이 섞인 부분은 "고쳐 달라기"를 써 주세요',
    notRegistered: '이 장은 지금 직접 고칠 수 없어요',
    comparing: '고친 부분 보기를 끄고 골라 주세요'
  },
  /** 편집칸(§3-2). */
  save: '저장',
  cancel: '취소',
  slotLabel: '고칠 글자',
  /** 저장 뒤 한 줄(§3-3, §4-5-6 — 되돌리기 단추는 없다). */
  saved: '고쳤어요.',
  savedNeedsCheck: '고쳤어요. 자료와 연결된 문장이라, 다음에 도우미에게 말을 걸 때 맞는지 함께 확인해요.',
  /** 제출 전 점검 안내(설계 §6-5, §4-5-8 07). 가벼운 고침에도 붙는다. */
  saveRecheck: '이 장은 제출 전에 도우미 점검을 한 번 받아야 해요.',
  listRecheck: (titles: string) => `제출 전 점검이 필요한 장: ${titles}`,
  /** 목록·점(§3-3). */
  listButton: (n: number) => `직접 고친 곳 ${n}`,
  listTitle: '직접 고친 곳',
  listEmpty: '직접 고친 곳이 없어요.',
  listState: {
    plain: '저장됨',
    pending: '확인 전',
    sent: '도우미에게 전달됨',
    // 전달은 확인이 아니다 — 그 턴이 정상으로 끝났을 때만 이 말을 쓴다(§5·§6-3).
    answered: '도우미가 답했어요'
  } as Record<string, string>,
  dotHint: '확인 전 — 도우미에게 말을 걸 때 함께 확인해요',
  /** 같은 낱말(§3-4). */
  elsewhere: (word: string, n: number) => `다른 곳에도 '${word}'가 ${n}군데 있어요.`,
  showAll: '모두 보기',
  fixTogether: '같이 고치기',
  askHelper: '도우미에게 맡기기',
  keep: '그대로',
  fixTogetherLead: (n: number) => `${n}군데 고치기`,
  /** 목록 안에서만 저장한다(§3-4, Roh 03). 목록 제목·머리. */
  sameWordListTitle: '같이 고칠 곳',
  sameWordListNone: '고칠 곳을 모두 뺐어요.',
  askHelperDraft: (word: string) => `논문 전체에서 '${word}' 내용을 빼 줘`,
  /** 복구·보관 알림(§4-5-6). 문구는 sidecar 가 준 `message` 를 그대로 쓴다. */
  noticeTitle: '원고 확인',
  noticeConfirm: '확인',
  noticePath: (path: string) => `보관 위치: ${path}`,
  noticeOpenFolder: '폴더 열기',
  /** 입력칸 위 칩 — 확인 전 고침이 있을 때(§3-3, §6). */
  chip: (n: number) => `직접 고친 문장 ${n}개 — 보낼 때 도우미가 확인해요`,
  /** 목록 맨 위 — 메모만 담은 메시지를 바로 보낸다(§6-4). */
  askNow: '지금 확인받기',
  askNowLead: (n: number) => `확인 전 고침 ${n}건이 있어요.`,
  /** 목록의 한 줄 — 그 건을 `pending` 으로 되돌려 다음 메시지에 다시 싣는다(§6-3). */
  askAgain: '다시 확인 요청',
  /** 실패 — 자세히 보기(§3-5). */
  failureMore: '자세히 보기'
} as const
