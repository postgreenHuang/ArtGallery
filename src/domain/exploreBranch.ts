import type { Artwork, SearchCriteria } from "../types";

export type BranchRelation = "composition" | "medium";
export interface BranchPlan { relation: BranchRelation; label: string; request: string; query: string; criteria: SearchCriteria }

export function planArtworkBranch(art: Artwork, relation: BranchRelation): BranchPlan {
  const subject = art.facets?.subjects?.[0]?.value.trim();
  const seed = (subject || art.title).replace(/\s+/g, " ").slice(0, 90);
  if (relation === "composition") return {
    relation, label: "构图相近", request: `以《${art.title}》为参照找构图相近的其他作品；相似性需要看图核实。`,
    query: `${seed} composition`.slice(0, 160),
    criteria: { required: subject ? [subject] : [], preferred: ["构图相近"], excluded: [], requiresImage: true },
  };
  const currentMedium = art.facets?.medium?.value || art.medium || "";
  const other = /(?:print|woodcut|etching|lithograph|版画|木刻|蚀刻)/i.test(currentMedium) ? "painting" : "print";
  return { relation, label: "同题材异媒材", request: `以《${art.title}》的题材为参照，找${other === "print" ? "版画" : "绘画"}中的其他作品。`,
    query: `${seed} ${other}`.slice(0, 160),
    criteria: { required: [...(subject ? [subject] : []), other === "print" ? "版画" : "绘画"],
      preferred: [], excluded: [], requiresImage: !!subject },
  };
}
