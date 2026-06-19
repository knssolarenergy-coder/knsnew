import { eq, sql } from "drizzle-orm";
import { Router } from "express";
import { db, siteVisits, users } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { notifyTechnician } from "../lib/notifications.js";

const router = Router();

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

async function withTechnicianName(rows: (typeof siteVisits.$inferSelect)[]) {
  if (rows.length === 0) return rows.map((r) => ({ ...r, technicianName: null as string | null }));
  const techIds = [...new Set(rows.map((r) => r.assignedTo).filter(Boolean))] as string[];
  const techs = techIds.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(sql`${users.id} = ANY(${techIds})`)
    : [];
  const nameMap: Record<string, string> = {};
  for (const t of techs) nameMap[t.id] = t.name;
  return rows.map((r) => ({ ...r, technicianName: r.assignedTo ? (nameMap[r.assignedTo] ?? null) : null }));
}

// GET /site-visits — admin: all; technician: assigned to them
router.get("/site-visits", requireAuth, async (req, res) => {
  try {
    let rows: (typeof siteVisits.$inferSelect)[];
    if (req.auth!.isAdmin) {
      rows = await db.select().from(siteVisits).orderBy(sql`${siteVisits.createdAt} DESC`);
    } else if (req.auth!.isTechnician) {
      rows = await db
        .select()
        .from(siteVisits)
        .where(eq(siteVisits.assignedTo, req.auth!.userId))
        .orderBy(sql`${siteVisits.createdAt} DESC`);
    } else {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    res.json(await withTechnicianName(rows));
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
    const [result] = await withTechnicianName([row]);
    req.log.info({ id: row.id }, "Site visit created");
    res.status(201).json(result);
    if (row.assignedTo) {
      notifyTechnician(row.assignedTo, {
        pushTitle: "Site Visit Assigned 📍",
        pushBody: `${row.purpose} — ${row.customerName}${row.scheduledDate ? ` on ${row.scheduledDate}` : ""}`,
        pushData: { type: "site_visit_assigned", id: row.id },
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
      if (!req.auth!.isTechnician || existing.assignedTo !== req.auth!.userId) {
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
      const [result] = await withTechnicianName([existing]);
      res.json(result); return;
    }

    const prevAssignedTo = existing.assignedTo;
    const [updated] = await db.update(siteVisits).set(updates).where(eq(siteVisits.id, id)).returning();
    const [result] = await withTechnicianName([updated]);
    req.log.info({ id }, "Site visit updated");
    res.json(result);
    // Notify newly assigned technician
    if (updated.assignedTo && updated.assignedTo !== prevAssignedTo) {
      notifyTechnician(updated.assignedTo, {
        pushTitle: "Site Visit Assigned 📍",
        pushBody: `${updated.purpose} — ${updated.customerName}${updated.scheduledDate ? ` on ${updated.scheduledDate}` : ""}`,
        pushData: { type: "site_visit_assigned", id: updated.id },
      }).catch(() => {});
    }
  } catch (err) {
    req.log.error({ err }, "Failed to update site visit");
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
