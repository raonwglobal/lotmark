export const SCORES = { IRC:40, ERC:30, LURC:30, DPI_PORTAL:20, FIELD_PHOTO:25, GOV_DOC:15, NEWS:10, SELLER_DOC:5 };

export function calculateGrade(project){
  const sources = project.sources || [];
  let score = 0;
  const has = (t)=> sources.some(s=>s.docType===t);
  sources.forEach(s=> score+=SCORES[s.docType]||0);
  const hasField = sources.filter(s=>s.docType==='FIELD_PHOTO').length>=3;
  let grade, reason;
  if(has('IRC') && has('ERC') && has('LURC') && hasField){ grade='A'; reason='IRC+ERC+LURC+현장 3장 이상 확인'; }
  else if((has('IRC')||has('ERC')) && has('DPI_PORTAL') && score>=50){ grade='B'; reason='공식자료 1종 + 기업정보 일치'; }
  else if(score>=25){ grade='C'; reason='MOU/언론/공문 기반'; }
  else if(score>=5){ grade='D'; reason='민간 매물 정보'; }
  else { grade='E'; reason='출처 부족/검증 불가'; }
  if(project.sellerCompany?.blacklist){
    const order=['A','B','C','D','E']; const idx=order.indexOf(grade);
    if(idx<4){ grade=order[idx+1]; reason+=' (블랙리스트 강등)'; }
  }
  return { score, grade, reason };
}

/** Free tier: strip sensitive verification fields */
export function redactProjectForPlan(project, plan, dataRoomPurchases = []) {
  if (!project) return project;
  const p = { ...project };
  const paid = plan && plan !== 'free';
  const hasDataRoom = dataRoomPurchases?.includes(project.projectId);

  if (!paid) {
    // Free: list-level summary only
    return {
      projectId: p.projectId,
      name: p.name,
      region: p.region,
      type: p.type,
      status: p.status,
      grade: p.grade,
      areaSqm: p.areaSqm,
      priceUsd: p.priceUsd,
      isPublic: p.isPublic,
      lastVerifiedDate: p.lastVerifiedDate,
      _gated: true,
      _upgradeRequired: true,
    };
  }

  // Paid: full record; DataRoom unlocks document URLs
  if (!hasDataRoom && p.sources) {
    p.sources = p.sources.map(s => ({
      docType: s.docType,
      trustScore: s.trustScore,
      isOfficial: s.isOfficial,
      fileUrl: null,
      _dataRoomRequired: true,
    }));
  }
  return p;
}
