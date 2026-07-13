import type { AdmissibilityContractDefinition, SelectorProfile } from "./policy-types.js";

const ADMISSIBILITY_CONTRACT_VERSION = "2026-04-18-v1";

const CONTRACTS: Partial<Record<SelectorProfile, AdmissibilityContractDefinition>> = {
  guidance_reference: {
    id: "guidance_reference_admissibility",
    version: ADMISSIBILITY_CONTRACT_VERSION,
    selectorProfile: "guidance_reference",
    selectionEngine: "contract_enforced",
    primaryGroups: ["planning_active", "architecture_reference"],
    secondaryGroups: ["recent_work", "session_handoff"],
    barredGroups: ["current_status", "operational_noise", "admin_process", "deploy_ops"],
    cappedGroups: [],
    continuityClasses: {
      durable_guidance: "preferred",
      transient_continuity: "capped",
      neutral: "disallowed",
    },
    requirePrimaryRepresentative: true,
  },
  workflow_posture: {
    id: "workflow_posture_admissibility",
    version: ADMISSIBILITY_CONTRACT_VERSION,
    selectorProfile: "workflow_posture",
    selectionEngine: "contract_enforced",
    primaryGroups: ["planning_active", "session_handoff"],
    secondaryGroups: ["recent_work", "architecture_reference"],
    barredGroups: ["operational_noise", "admin_process", "deploy_ops"],
    cappedGroups: [{ group: "current_status", max: 1 }],
    continuityClasses: {
      durable_guidance: "preferred",
      transient_continuity: "capped",
      neutral: "disallowed",
    },
    requirePrimaryRepresentative: true,
  },
  recent_work: {
    id: "recent_work_admissibility",
    version: ADMISSIBILITY_CONTRACT_VERSION,
    selectorProfile: "recent_work",
    selectionEngine: "contract_enforced",
    primaryGroups: ["recent_work", "planning_active", "architecture_reference"],
    secondaryGroups: ["session_handoff", "current_status"],
    barredGroups: ["operational_noise", "admin_process", "deploy_ops"],
    cappedGroups: [{ group: "current_status", max: 1 }],
    continuityClasses: {
      durable_guidance: "allowed",
      transient_continuity: "allowed",
      neutral: "disallowed",
    },
    requirePrimaryRepresentative: true,
  },
  status_continuity: {
    id: "status_continuity_compatibility",
    version: ADMISSIBILITY_CONTRACT_VERSION,
    selectorProfile: "status_continuity",
    selectionEngine: "continuity_resolved",
    primaryGroups: ["current_status", "session_handoff", "recent_work", "debugging_active"],
    secondaryGroups: ["planning_active", "architecture_reference"],
    barredGroups: [],
    cappedGroups: [],
    continuityClasses: {
      durable_guidance: "compatibility_only",
      transient_continuity: "compatibility_only",
      neutral: "compatibility_only",
    },
    requirePrimaryRepresentative: false,
    // Intentional boundary: this contract is audit metadata for the dedicated
    // status continuity resolver, not the behavioral enforcement engine.
    compatibilityMode: true,
  },
};

export function cloneAdmissibilityContract(
  contract: AdmissibilityContractDefinition,
): AdmissibilityContractDefinition {
  return {
    ...contract,
    primaryGroups: [...contract.primaryGroups],
    secondaryGroups: [...contract.secondaryGroups],
    barredGroups: [...contract.barredGroups],
    cappedGroups: contract.cappedGroups.map((cap) => ({ ...cap })),
    continuityClasses: { ...contract.continuityClasses },
  };
}

export function resolveAdmissibilityContractForSelectorProfile(
  selectorProfile: SelectorProfile,
): AdmissibilityContractDefinition | undefined {
  const contract = CONTRACTS[selectorProfile];
  return contract ? cloneAdmissibilityContract(contract) : undefined;
}
