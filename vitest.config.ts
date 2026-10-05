import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // workflow 테스트의 준비(에픽을 구현·검증 단계까지 진행)는 git 왕복이 많아, 전체를 병렬로 돌리면 기본 10초를 넘길 때가 있다
    hookTimeout: 60_000,
  },
});
