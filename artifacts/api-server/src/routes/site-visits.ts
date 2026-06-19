import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Router } from "express";
import { db, siteVisits, users, siteVisitTechnicians } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { notifyAdmins, notifyTechnician, siteVisitEmailHtml, adminNewSiteVisitEmailHtml } from "../lib/notifications.js";

const router = Router();

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

type SiteVisitWithTechs = typeof siteVisits.$inferSelect & { technicianName: string | null; technicianIds: string[] };

async function withTechnicianData(rows: (typeof siteVisits.$inferSelect)[]): Promise<SiteVisitWithTechs[]> {
  if (rows.length === 0) return rows.map((r) => ({ ...r, technicianName: null, technicianIds: [] }));

  // Fetch names for legacy assignedTo
  const techIds = [...new Set(rows.map((r) => r.assignedTo).filter(Boolean))] as string[];
  const techs = techIds.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(sql`${users.id} = ANY(${techIds})`)
    : [];
  const nameMap: Record<string, string> = {};
  for (const t of techs) nameMap[t.id] = t.name;

  // Fetch join table technician IDs
  const ids = rows.map((r) => r.id);
  const techRows = await db
    .select({ siteVisitId: siteVisitTechnicians.siteVisitId, technicianId: siteVisitTechnicians.technicianId })
    .from(siteVisitTechnicians)
    .where(inArray(siteVisitTechnicians.siteVisitId, ids));
  const techIdsMap: Record<string, string[]> = {};
  for (const row of techRows) {
    if (!techIdsMap[row.siteVisitId]) techIdsMap[row.siteVisitId] = [];
    techIdsMap[row.siteVisitId].push(row.technicianId);
  }

  return rows.map((r) => {
    const ids = techIdsMap[r.id];
    const hasJoinIds = ids && ids.length > 0;
    return {
      ...r,
      technicianName: r.assignedTo ? (nameMap[r.assignedTo] ?? null) : null,
      // Fall back to legacy assignedTo column when join table has no rows yet
      technicianIds: hasJoinIds ? ids : (r.assignedTo ? [r.assignedTo] : []),
    };
  });
}

// GET /site-visits — admin: all; technician: assigned to them
router.get("/site-visits", requireAuth, async (req, res) => {
  try {
    let rows: (typeof siteVisits.$inferSelect)[];
    if (req.auth!.isAdmin) {
      rows = await db.select().from(siteVisits).orderBy(sql`${siteVisits.createdAt} DESC`);
    } else if (req.auth!.isTechnician) {
      const userId = req.auth!.userId;
      rows = await db
        .select()
        .from(siteVisits)
        .where(
          or(
            eq(siteVisits.assignedTo, userId),
            inArray(
              siteVisits.id,
              db.select({ siteVisitId: siteVisitTechnicians.siteVisitId })
                .from(siteVisitTechnicians)
                .where(eq(siteVisitTechnicians.technicianId, userId))
            )
          )
        )
        .orderBy(sql`${siteVisits.createdAt} DESC`);
    } else {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    res.json(await withTechnicianData(rows));
  } catch (err) {
    req.log.error({ err }, "Failed to get site visits");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /site-visits — admin only
router.post("/site-visits", requireAdmin, async (req, res) => {
  try {
    const { customerName, phone, address, city, purpose, notes, assignedTo, scheduledDate, scheduledTime } = req.body;
    if (!customerName || !phone || !address || !purpose) {
      res.status(400).json({ error: "customerName, phone, address, purpose are required" }); return;
    }
    const [row] = await db.insert(siteVisits).values({
      id: generateId(),
      customerName: String(customerName),
      phone: String(phone),
      address: String(address),
      city: city ? String(city) : null,
      purpose: String(purpose),
      notes: notes ? String(notes) : null,
      status: "pending",
      assignedTo: assignedTo ? String(assignedTo) : null,
      scheduledDate: scheduledDate ? String(scheduledDate) : null,
      scheduledTime: scheduledTime ? String(scheduledTime) : null,
    }).returning();
    const [result] = await withTechnicianData([row]);
    req.log.info({ id: row.id }, "Site visit created");
    res.status(201).json(result);
    notifyAdmins({
      pushTitle: "New Site Visit 📍",
      pushBody: `${row.customerName} — ${row.purpose}`,
      pushData: { type: "site_visit_created", id: row.id },
      emailSubject: `New Site Visit: ${row.customerName}`,
      emailHtml: adminNewSiteVisitEmailHtml(row.customerName, row.phone, row.purpose, row.address, row.scheduledDate, row.scheduledTime),
    }).catch(() => {});
    if (row.assignedTo) {
      notifyTechnician(row.assignedTo, {
        pushTitle: "Site Visit Assigned 📍",
        pushBody: `${row.purpose} — ${row.customerName}${row.scheduledDate ? ` on ${row.scheduledDate}` : ""}`,
        pushData: { type: "site_visit_assigned", id: row.id },
        emailSubject: `Site Visit Assigned — ${row.customerName}`,
        emailHtml: (techName) => siteVisitEmailHtml(techName, row.customerName, row.purpose, row.address, row.scheduledDate, row.scheduledTime),
      }).catch(() => {});
    }
  } catch (err) {
    req.log.error({ err }, "Failed to create site visit");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /site-visits/:id — admin: any field; technician: status + technicianNotes only
router.patch("/site-visits/:id", requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id);
    const [existing] = await db.select().from(siteVisits).where(eq(siteVisits.id, id));
    if (!existing) { res.status(404).json({ error: "Site visit not found" }); return; }

    if (!req.auth!.isAdmin) {
      if (!req.auth!.isTechnician) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      // Check via join table or legacy assignedTo
      const [row] = await db.select({ id: siteVisitTechnicians.id })
        .from(siteVisitTechnicians)
        .where(and(eq(siteVisitTechnicians.siteVisitId, id), eq(siteVisitTechnicians.technicianId, req.auth!.userId)));
      if (!row && existing.assignedTo !== req.auth!.userId) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
    }

    const updates: Partial<typeof siteVisits.$inferInsert> = {};
    const { customerName, phone, address, city, purpose, notes, assignedTo, scheduledDate, scheduledTime, status, technicianNotes } = req.body;

    if (req.auth!.isAdmin) {
      if (customerName !== undefined) updates.customerName = String(customerName);
      if (phone !== undefined) updates.phone = String(phone);
      if (address !== undefined) updates.address = String(address);
      if (city !== undefined) updates.city = city ? String(city) : null;
      if (purpose !== undefined) updates.purpose = String(purpose);
      if (notes !== undefined) updates.notes = notes ? String(notes) : null;
      if (assignedTo !== undefined) updates.assignedTo = assignedTo ? String(assignedTo) : null;
      if (scheduledDate !== undefined) updates.scheduledDate = scheduledDate ? String(scheduledDate) : null;
      if (scheduledTime !== undefined) updates.scheduledTime = scheduledTime ? String(scheduledTime) : null;
    }
    if (status !== undefined) updates.status = String(status);
    if (technicianNotes !== undefined) updates.technicianNotes = technicianNotes ? String(technicianNotes) : null;

    if (Object.keys(updates).length === 0) {
      const [result] = await withTechnicianData([existing]);
      res.json(result); return;
    }

    const prevAssignedTo = existing.assignedTo;
    const [updated] = await db.update(siteVisits).set(updates).where(eq(siteVisits.id, id)).returning();
    const [result] = await withTechnicianData([updated]);
    req.log.info({ id }, "Site visit updated");
    res.json(result);
    // Notify newly assigned technician (legacy assignedTo)
    if (updated.assignedTo && updated.assignedTo !== prevAssignedTo) {
      notifyTechnician(updated.assignedTo, {
        pushTitle: "Site Visit Assigned 📍",
        pushBody: `${updated.purpose} — ${updated.customerName}${updated.scheduledDate ? ` on ${updated.scheduledDate}` : ""}`,
        pushData: { type: "site_visit_assigned", id: updated.id },
        emailSubject: `Site Visit Assigned — ${updated.customerName}`,
        emailHtml: (techName) => siteVisitEmailHtml(techName, updated.customerName, updated.purpose, updated.address, updated.scheduledDate, updated.scheduledTime),
      }).catch(() => {});
    }
  } catch (err) {
    req.log.error({ err }, "Failed to update site visit");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /site-visits/:id/technicians — assign multiple technicians (admin only)
router.put("/site-visits/:id/technicians", requireAdmin, async (req, res) => {
  try {
    const { technicianIds } = req.body;
    if (!Array.isArray(technicianIds)) {
      res.status(400).json({ error: "technicianIds must be an array" }); return;
    }
    const siteVisitId = String(req.params.id);
    const [visit] = await db.select().from(siteVisits).where(eq(siteVisits.id, siteVisitId));
    if (!visit) { res.status(404).json({ error: "Site visit not found" }); return; }
    await db.delete(siteVisitTechnicians).where(eq(siteVisitTechnicians.siteVisitId, siteVisitId));
    if (technicianIds.length > 0) {
      await db.insert(siteVisitTechnicians).values(
        technicianIds.map((techId: string) => ({
          id: generateId(),
          siteVisitId,
          technicianId: String(techId),
        }))
      );
    }
    // Also sync legacy assignedTo to first assigned technician
    await db.update(siteVisits)
      .set({ assignedTo: technicianIds.length > 0 ? String(technicianIds[0]) : null })
      .where(eq(siteVisits.id, siteVisitId));
    const [updatedVisit] = await db.select().from(siteVisits).where(eq(siteVisits.id, siteVisitId));
    const [result] = await withTechnicianData([updatedVisit]);
    res.json(result);
    req.log.info({ siteVisitId, technicianIds }, "Site visit technicians updated");
    // Notify each newly assigned technician
    for (const techId of technicianIds as string[]) {
      notifyTechnician(techId, {
        pushTitle: "Site Visit Assigned 📍",
        pushBody: `${visit.purpose} — ${visit.customerName}${visit.scheduledDate ? ` on ${visit.scheduledDate}` : ""}`,
        pushData: { type: "site_visit_assigned", id: siteVisitId },
        emailSubject: `Site Visit Assigned — ${visit.customerName}`,
        emailHtml: (techName) => siteVisitEmailHtml(techName, visit.customerName, visit.purpose, visit.address, visit.scheduledDate, visit.scheduledTime),
      }).catch(() => {});
    }
  } catch (err) {
    req.log.error({ err }, "Failed to assign site visit technicians");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /site-visits/:id — admin only
router.delete("/site-visits/:id", requireAdmin, async (req, res) => {
  try {
    const [deleted] = await db.delete(siteVisits).where(eq(siteVisits.id, String(req.params.id))).returning();
    if (!deleted) { res.status(404).json({ error: "Site visit not found" }); return; }
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to delete site visit");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
