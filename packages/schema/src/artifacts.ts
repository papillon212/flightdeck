/** 산출물의 필수 섹션 (설계 §6.3). `## <섹션>` 제목으로 이 순서대로 있어야 한다 */
export const ANALYSIS_SECTIONS = ["요구사항 요약", "영향 범위", "불명확한 점", "가정"] as const;
export const DESIGN_SECTIONS = ["개요", "변경 컴포넌트", "인터페이스", "데이터 변경", "테스트 계획", "리스크"] as const;

/** handoff.md의 필수 섹션 (설계 §6.4) */
export const HANDOFF_SECTIONS = [
  "목표",
  "읽은 파일",
  "결정과 이유",
  "버린 대안",
  "실패한 시도",
  "가정",
  "남은 리스크",
  "다음 실행자에게",
] as const;

/** 단계별 산출물 파일 (설계 §2.2) */
export const PHASE_ARTIFACT = {
  ANALYSIS: { file: "analysis.md", sections: ANALYSIS_SECTIONS },
  DESIGN: { file: "design.md", sections: DESIGN_SECTIONS },
} as const;
