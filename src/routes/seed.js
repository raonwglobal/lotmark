/** Sample project seed */
import { getProjectModel } from '../lib/db.js';
import { resolveUser, requireUser } from '../lib/auth.js';
import { parseGps, applyGrade } from '../lib/helpers.js';

export function registerSeedRoutes(app) {
  app.post('/api/seed', async (c) => {
    const user = await resolveUser(c);
    const err = requireUser(user);
    if (err) return c.json({ error: err.error }, err.status);
    const samples = [
      {
        name: 'Thu Duc Industrial Sample', region: 'HCMC', type: 'industrial', status: 'active',
        areaSqm: 50000, priceUsd: 12000000,
        sellerCompany: { name: 'ABC Land', taxCode: '0312345678', blacklist: false },
        sources: [
          { docType: 'IRC', fileUrl: 'https://example.com/irc.pdf', trustScore: 90, isOfficial: true },
          { docType: 'ERC', fileUrl: 'https://example.com/erc.pdf', trustScore: 85, isOfficial: true },
          { docType: 'LURC', fileUrl: 'https://example.com/lurc.pdf', trustScore: 80, isOfficial: true },
          { docType: 'FIELD_PHOTO', fileUrl: 'https://example.com/1.jpg', trustScore: 70, isOfficial: false },
          { docType: 'FIELD_PHOTO', fileUrl: 'https://example.com/2.jpg', trustScore: 70, isOfficial: false },
          { docType: 'FIELD_PHOTO', fileUrl: 'https://example.com/3.jpg', trustScore: 70, isOfficial: false },
        ],
        verifiedFacts: 'IRC/ERC/LURC confirmed', gps: { raw: '10.8500, 106.7500' }, isPublic: true,
      },
      {
        name: 'Binh Duong MOU Listing', region: 'Binh Duong', type: 'residential', status: 'listed',
        areaSqm: 12000, priceUsd: 3500000,
        sellerCompany: { name: 'Local Broker Co', taxCode: '0309988776', blacklist: false },
        sources: [
          { docType: 'NEWS', fileUrl: 'https://example.com/news.html', trustScore: 40, isOfficial: false },
          { docType: 'SELLER_DOC', fileUrl: 'https://example.com/mou.pdf', trustScore: 30, isOfficial: false },
        ],
        verifiedFacts: '', unverifiedItems: 'official permits unverified', gps: { raw: '11.0000, 106.6500' }, isPublic: true,
      },
    ];
    const Project = await getProjectModel(c.env);
    const created = [];
    for (const s of samples) {
      let data = { ...s, projectId: `LM-SEED-${Date.now()}-${created.length}`, ownerId: String(user._id) };
      parseGps(data);
      applyGrade(data);
      const doc = await Project.create(data);
      created.push({ projectId: doc.projectId, name: doc.name, grade: doc.grade, score: doc.score });
      await new Promise(r => setTimeout(r, 5));
    }
    return c.json({ created });
  });
}
