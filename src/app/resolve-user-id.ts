export function resolveUserId(bodyUserId: unknown, currentCfg: { userId: string }): string {
  const singleTenantId = process.env.RUNIR_SINGLE_TENANT;
  if (bodyUserId !== undefined && typeof bodyUserId !== "string") {
    throw new Error("invalid userId");
  }
  if (singleTenantId) {
    if (bodyUserId && bodyUserId !== singleTenantId) {
      throw new Error(`userId mismatch: expected ${singleTenantId}`);
    }
    return singleTenantId;
  }
  return bodyUserId ?? currentCfg.userId;
}
