/**
 * Creates a real organization with its first branch and its owner account, for a fresh
 * production install (the demo seed is for trials only). Idempotent on the owner's email.
 *
 *   ORG_NAME="Spice Garden" ORG_LEGAL_NAME="Spice Garden Foods Pvt Ltd" ORG_STATE_CODE=29 \
 *   ORG_GSTIN=29AABCS1234F1Z5 BRANCH_NAME="Indiranagar" BRANCH_CODE=BLR-IND \
 *   OWNER_EMAIL=owner@spicegarden.in OWNER_NAME="Asha Rao" OWNER_PASSWORD='…' \
 *   node dist-seed/prisma/create-organization.js
 */
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { checkPasswordPolicy, PASSWORD_POLICY } from '../src/modules/auth/password.service';
import { provisionDefaultRoles } from '../src/modules/rbac/catalog-sync';

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export async function createOrganization(db: PrismaClient, env: NodeJS.ProcessEnv = process.env) {
  const get = (k: string) => env[k]?.trim() || undefined;
  const required = (k: string) => {
    const v = get(k);
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const stateCode = required('ORG_STATE_CODE').padStart(2, '0');
  const gstin = get('ORG_GSTIN')?.toUpperCase();
  if (!/^\d{2}$/.test(stateCode)) throw new Error('ORG_STATE_CODE must be the 2-digit GST state code, e.g. 29 for Karnataka');
  if (gstin && (!GSTIN.test(gstin) || gstin.slice(0, 2) !== stateCode)) throw new Error('ORG_GSTIN is not a valid GSTIN for that state');
  const email = required('OWNER_EMAIL').toLowerCase();
  const password = required('OWNER_PASSWORD');
  if (!checkPasswordPolicy(password)) throw new Error(`OWNER_PASSWORD: ${PASSWORD_POLICY}`);
  const branchCode = (get('BRANCH_CODE') ?? 'MAIN').toUpperCase();

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { created: false as const, organizationId: existing.organizationId, ownerId: existing.id };

  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  return db.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: required('ORG_NAME'), legalName: get('ORG_LEGAL_NAME') ?? null, gstin: gstin ?? null, pan: gstin ? gstin.slice(2, 12) : null, stateCode, email },
    });
    const branch = await tx.branch.create({
      data: { organizationId: org.id, code: branchCode, name: required('BRANCH_NAME'), stateCode, gstin: gstin ?? null },
    });
    await tx.branchSettings.create({ data: { branchId: branch.id, organizationId: org.id, invoicePrefix: branchCode.replace(/[^A-Z0-9]/g, '').slice(0, 10) } });
    await tx.kitchenStation.create({ data: { organizationId: org.id, branchId: branch.id, code: 'MAIN', name: 'Main Kitchen' } });
    const roles = await provisionDefaultRoles(tx, org.id);
    const owner = await tx.user.create({ data: { organizationId: org.id, email, fullName: required('OWNER_NAME'), passwordHash: hash } });
    await tx.userRole.create({ data: { organizationId: org.id, userId: owner.id, roleId: roles.get('OWNER')!, branchId: null } });
    await tx.auditLog.create({
      data: { organizationId: org.id, action: 'organization.created', entityType: 'organization', entityId: org.id, after: { name: org.name, branch: branch.code, owner: email } },
    });
    return { created: true as const, organizationId: org.id, branchId: branch.id, ownerId: owner.id };
  });
}

if (require.main === module) {
  const db = new PrismaClient();
  createOrganization(db)
    .then((r) => console.log(r.created ? `Organization created (${r.organizationId}); sign in as ${need('OWNER_EMAIL')}.` : `An account for ${need('OWNER_EMAIL')} already exists; nothing changed.`))
    .catch((e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
