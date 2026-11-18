# 후원 QR

QR 그림은 저장소에 넣지 않는다. 출시 빌드 직전에 Actions 비밀값 `SUPPORT_QR_TOSS_B64`, `SUPPORT_QR_KAKAOPAY_B64`의 base64를 풀어 각각 이 폴더의 `toss.png`, `kakaopay.png`에 쓰면 빌드에 포함된다. 비밀값 등록과 workflow 수정은 형님·오모냥 몫이다. 파일이 없으면 앱에 준비 중 안내가 보인다.
