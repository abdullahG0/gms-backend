// server.js — Garage Management System (production-ready)
//
// Features:
// - Env-driven CORS (supports Netlify/localhost)
// - Postgres SSL in production (Render)
// - Persistent uploads via UPLOAD_ROOT (Render Disk or local)
// - Year-based archive uploads
// - Worker payments with optional custom payment_date
// - Invoice & payments PDF generation
//
// Requirements: express, cors, dotenv, pg, multer, pdfkit
//   npm i express cors dotenv pg multer pdfkit

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const PDFDocument = require('pdfkit');

dotenv.config();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

// ---------- CORS (env-driven) ----------

const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// If CORS_ORIGIN is not set, default to permissive during bring-up.
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET','HEAD','PUT','PATCH','POST','DELETE'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));


// ---------- Postgres (SSL in production) ----------
const isProd = process.env.NODE_ENV === 'production';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(isProd ? { ssl: { rejectUnauthorized: false } } : {}),
});

// Quick pool test
(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('DB connection successful');
  } catch (err) {
    console.error('DB connection failed:', err);
  }
})();
// ---- PDF header (logo) helper ----
const ASSETS_DIR = process.env.ASSETS_DIR || path.join(process.cwd(), 'assets');
const PDF_LOGO_PATH = process.env.PDF_LOGO_PATH || path.join(ASSETS_DIR, 'logo.png');
const hasPdfLogo = fs.existsSync(PDF_LOGO_PATH);

/**
 * Draw a consistent header with logo + title
 *  - Puts the logo on the left (if present), and the title to the right
 *  - Draws a light divider line under the header
 * After calling this, the cursor is positioned below the header area.
 */
function drawPdfHeader(doc, title) {
  const top = 40;
  const left = 50;

  if (hasPdfLogo) {
    try {
      // Fit the logo – adjust if you want it bigger/smaller
      doc.image(PDF_LOGO_PATH, left, top, { fit: [220, 60] });
    } catch (e) {
      console.warn('PDF logo failed to load:', e.message);
    }
    doc.fontSize(18).text(title, left + 240, top + 15, { align: 'left' });
  } else {
    doc.fontSize(18).text(title, { align: 'center' });
  }

  // Divider
  const lineY = 110;
  doc.strokeColor('#e5e7eb').moveTo(left, lineY).lineTo(550, lineY).stroke();
  doc.strokeColor('black');

  // Move down into content area
  doc.moveDown(0.5);
  doc.y = Math.max(doc.y, lineY + 10);
}

// ---------- Health check ----------
app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// ---------- Uploads (env-configurable root) ----------
/**
 * Use UPLOAD_ROOT for persistent storage.
 * On Render: attach a Disk and set UPLOAD_ROOT=/var/data/uploads
 * Locally: it falls back to ./uploads
 */
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(process.cwd(), 'uploads');
const INVOICE_DIR = path.join(UPLOAD_ROOT, 'invoices');
fs.mkdirSync(INVOICE_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Accept any 4-digit year; validate lightly
    const year = String(req.body.year || '').trim();
    if (!/^\d{4}$/.test(year)) return cb(new Error('Invalid year'), null);
    const dest = path.join(INVOICE_DIR, year);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-() ]+/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage });

// Serve uploaded files at /uploads/...
app.use('/uploads', express.static(UPLOAD_ROOT));

// ---------- PARTS ----------
app.get('/api/parts', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM parts ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error('Error fetching parts:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/parts', async (req, res) => {
  try {
    const { name, part_number, purchasing_cost, selling_cost, quantity_in_stock } = req.body;
    if (!name || !part_number || purchasing_cost == null || selling_cost == null) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO parts (name, part_number, purchasing_cost, selling_cost, quantity_in_stock)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, part_number, purchasing_cost, selling_cost, quantity_in_stock || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creating part:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/parts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, part_number, purchasing_cost, selling_cost, quantity_in_stock } = req.body;
    if (!name || !part_number || purchasing_cost == null || selling_cost == null) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    const { rows } = await pool.query(
      `UPDATE parts
       SET name = $1, part_number = $2, purchasing_cost = $3, selling_cost = $4, quantity_in_stock = $5
       WHERE id = $6 RETURNING *`,
      [name, part_number, purchasing_cost, selling_cost, quantity_in_stock || 0, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Part not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Error updating part:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/parts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM parts WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Part not found' });
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting part:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- WORKERS ----------
app.get('/api/workers', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM workers ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error('Error fetching workers:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/workers', async (req, res) => {
  try {
    const { name, job_title, phone, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const { rows } = await pool.query(
      `INSERT INTO workers (name, job_title, phone, email)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, job_title || null, phone || null, email || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creating worker:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Safer delete: unassign from services, remove payments, then delete worker
app.delete('/api/workers/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    // Unassign from services (requires FK ON DELETE SET NULL, but this makes it safe regardless)
    await client.query('UPDATE services SET worker_id = NULL WHERE worker_id = $1', [id]);

    // Delete dependent payments
    await client.query('DELETE FROM worker_payments WHERE worker_id = $1', [id]);

    // Delete worker
    const result = await client.query('DELETE FROM workers WHERE id = $1 RETURNING id', [id]);

    await client.query('COMMIT');

    if (result.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting worker:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ---------- SERVICES ----------
app.get('/api/services', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.name, s.category, s.worker_id, w.name AS worker_name
      FROM services s
      LEFT JOIN workers w ON w.id = s.worker_id
      ORDER BY s.name
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching services:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/services/:id/assign-worker', async (req, res) => {
  const { id } = req.params;
  const { worker_id } = req.body;
  if (!worker_id) return res.status(400).json({ error: 'worker_id is required' });

  try {
    const result = await pool.query(
      'UPDATE services SET worker_id = $1 WHERE id = $2 RETURNING *',
      [worker_id, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Service not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error assigning worker:', err);
    res.status(500).json({ error: 'Failed to assign worker' });
  }
});

// ---------- VEHICLES ----------
app.get('/api/vehicles', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT v.*,
             COALESCE(
               json_agg(
                 DISTINCT jsonb_build_object(
                   'id', s.id,
                   'name', s.name,
                   'status', vs.status,
                   'completed_time', vs.completed_time,
                   'worker_id', s.worker_id,
                   'worker_name', w.name
                 )
               ) FILTER (WHERE s.id IS NOT NULL), '[]'
             ) AS services
      FROM vehicles v
      LEFT JOIN vehicle_services vs ON v.id = vs.vehicle_id
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN workers w ON w.id = s.worker_id
      GROUP BY v.id
      ORDER BY v.entry_time DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching vehicles:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/vehicles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `
      SELECT
        v.*,
        COALESCE(
          (
            SELECT json_agg(
              jsonb_build_object(
                'id', s.id,
                'name', s.name,
                'status', vs.status,
                'completed_time', vs.completed_time,
                'worker_id', s.worker_id,
                'worker_name', w.name,
                'parts', COALESCE(
                  (
                    SELECT json_agg(
                      jsonb_build_object(
                        'id', p.id,
                        'name', p.name,
                        'part_number', p.part_number,
                        'quantity', vsp.quantity,
                        'purchasing_cost', p.purchasing_cost,
                        'selling_cost', p.selling_cost,
                        'quantity_in_stock', p.quantity_in_stock
                      )
                    )
                    FROM vehicle_service_parts vsp
                    JOIN parts p ON vsp.part_id = p.id
                    WHERE vsp.vehicle_id = v.id AND vsp.service_id = s.id
                  ), '[]'
                )
              )
            )
            FROM vehicle_services vs
            JOIN services s ON s.id = vs.service_id
            LEFT JOIN workers w ON w.id = s.worker_id
            WHERE vs.vehicle_id = v.id
          ), '[]'
        ) AS services,
        COALESCE(
          (
            SELECT json_agg(
              jsonb_build_object(
                'id', p.id,
                'name', p.name,
                'part_number', p.part_number,
                'quantity', vp.quantity,
                'purchasing_cost', p.purchasing_cost,
                'selling_cost', p.selling_cost,
                'quantity_in_stock', p.quantity_in_stock
              )
            )
            FROM vehicle_parts vp
            JOIN parts p ON vp.part_id = p.id
            WHERE vp.vehicle_id = v.id
          ), '[]'
        ) AS standalone_parts,
        COALESCE(
          (
            SELECT to_json(i)
            FROM invoices i
            WHERE i.vehicle_id = v.id
            ORDER BY i.id DESC
            LIMIT 1
          ), NULL
        ) AS invoice
      FROM vehicles v
      WHERE v.id = $1
      `,
      [id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Vehicle not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Error fetching vehicle:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/vehicles', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      plate, make, model_name, year, vin, owner, contact_number,
      service_ids, standalone_parts, service_parts
    } = req.body;

    if (!plate || !owner || !contact_number) {
      return res.status(400).json({ error: 'Plate, owner, and contact number are required' });
    }

    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO vehicles (plate, make, model_name, year, vin, owner, contact_number, entry_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       RETURNING *`,
      [plate, make, model_name, year, vin, owner, contact_number]
    );
    const vehicle = rows[0];

    if (Array.isArray(service_ids)) {
      for (const service_id of service_ids) {
        await client.query(
          `INSERT INTO vehicle_services (vehicle_id, service_id, status)
           VALUES ($1, $2, 'pending')`,
          [vehicle.id, service_id]
        );
      }
    }

    if (Array.isArray(standalone_parts)) {
      for (const part of standalone_parts) {
        await client.query(
          `INSERT INTO vehicle_parts (vehicle_id, part_id, quantity)
           VALUES ($1, $2, $3)`,
          [vehicle.id, part.part_id, part.quantity]
        );
      }
    }

    if (Array.isArray(service_parts)) {
      for (const sp of service_parts) {
        await client.query(
          `INSERT INTO vehicle_service_parts (vehicle_id, service_id, part_id, quantity)
           VALUES ($1, $2, $3, $4)`,
          [vehicle.id, sp.service_id, sp.part_id, sp.quantity]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json(vehicle);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating vehicle:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.put('/api/vehicles/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { plate, make, model_name, year, vin, owner, contact_number, standalone_parts, service_parts } = req.body;

    if (!plate || !owner || !contact_number) {
      return res.status(400).json({ error: 'Plate, owner, and contact number are required' });
    }

    await client.query('BEGIN');

    const { rows: vehicleRows } = await client.query(
      `UPDATE vehicles
       SET plate = $1, make = $2, model_name = $3, year = $4, vin = $5, owner = $6, contact_number = $7
       WHERE id = $8
       RETURNING *`,
      [plate, make, model_name, year, vin, owner, contact_number, id]
    );
    if (vehicleRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vehicle not found' });
    }

    await client.query(`DELETE FROM vehicle_parts WHERE vehicle_id = $1`, [id]);
    if (Array.isArray(standalone_parts)) {
      for (const part of standalone_parts) {
        await client.query(
          `INSERT INTO vehicle_parts (vehicle_id, part_id, quantity)
           VALUES ($1, $2, $3)`,
          [id, part.part_id, part.quantity]
        );
      }
    }

    await client.query(`DELETE FROM vehicle_service_parts WHERE vehicle_id = $1`, [id]);
    if (Array.isArray(service_parts)) {
      for (const sp of service_parts) {
        await client.query(
          `INSERT INTO vehicle_service_parts (vehicle_id, service_id, part_id, quantity)
           VALUES ($1, $2, $3, $4)`,
          [id, sp.service_id, sp.part_id, sp.quantity]
        );
      }
    }

    await client.query('COMMIT');
    res.json(vehicleRows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating vehicle:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.put('/api/vehicles/:id/exit', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM vehicle_services WHERE vehicle_id = $1 AND status != 'completed'`,
      [id]
    );
    if (parseInt(rows[0].count, 10) > 0) {
      return res.status(400).json({ error: 'All services must be completed before exiting.' });
    }

    const { rows: invoiceRows } = await pool.query(
      `SELECT COUNT(*) FROM invoices WHERE vehicle_id = $1`,
      [id]
    );
    if (parseInt(invoiceRows[0].count, 10) === 0) {
      return res.status(400).json({ error: 'Invoice must be generated before exiting.' });
    }

    await pool.query(`UPDATE vehicles SET exit_time = NOW() WHERE id = $1`, [id]);
    res.json({ message: 'Vehicle exited successfully.' });
  } catch (err) {
    console.error('Error exiting vehicle:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/vehicles/:vehicleId/services/:serviceId', async (req, res) => {
  try {
    const { vehicleId, serviceId } = req.params;
    const { status, completed_time } = req.body;

    const { rowCount } = await pool.query(
      `UPDATE vehicle_services SET status = $1, completed_time = $2
       WHERE vehicle_id = $3 AND service_id = $4`,
      [status, completed_time || null, vehicleId, serviceId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Service record not found' });
    res.json({ message: 'Service status updated successfully' });
  } catch (err) {
    console.error('Error updating service status:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/vehicles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM vehicles WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Vehicle not found' });
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting vehicle:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- INVOICES ----------
app.post('/api/invoices', async (req, res) => {
  const client = await pool.connect();
  try {
    const { vehicle_id, days_in_garage, services, parts } = req.body;
    if (!vehicle_id || !days_in_garage) {
      return res.status(400).json({ error: 'Vehicle ID and days in garage are required.' });
    }

    await client.query('BEGIN');

    // Insert invoice with placeholder totals
    const invoiceResult = await client.query(
      `INSERT INTO invoices (vehicle_id, days_in_garage, garage_stay_rate, subtotal, tax, total)
       VALUES ($1, $2, 5000, 0, 0, 0)
       RETURNING id`,
      [vehicle_id, days_in_garage]
    );
    const invoiceId = invoiceResult.rows[0].id;

    let itemsTotal = 0;

    // Service items
    if (Array.isArray(services)) {
      for (const svc of services) {
        const lineTotal = parseFloat(svc.unit_price || 0);
        itemsTotal += lineTotal;
        await client.query(
          `INSERT INTO invoice_items 
           (invoice_id, item_type, item_id, description, quantity, purchased_cost, unit_price, total)
           VALUES ($1, 'service', $2, $3, 1, NULL, $4, $5)`,
          [invoiceId, svc.id, svc.description, lineTotal, lineTotal]
        );
      }
    }

    // Parts items
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const partRes = await client.query(
          `SELECT purchasing_cost, selling_cost FROM parts WHERE id = $1`,
          [part.id]
        );
        if (partRes.rowCount === 0) throw new Error(`Part id ${part.id} not found`);
        const { purchasing_cost, selling_cost } = partRes.rows[0];
        const lineTotal = Number(selling_cost) * Number(part.quantity);
        itemsTotal += lineTotal;

        await client.query(
          `INSERT INTO invoice_items 
           (invoice_id, item_type, item_id, description, quantity, purchased_cost, unit_price, total)
           VALUES ($1, 'part', $2, $3, $4, $5, $6, $7)`,
          [invoiceId, part.id, part.description, part.quantity, purchasing_cost, selling_cost, lineTotal]
        );
      }
    }

    const garageStayTotal = Number(days_in_garage) * 5000;
    const subtotal = itemsTotal + garageStayTotal;
    const tax = subtotal * 0.18;
    const total = subtotal + tax;

    await client.query(
      `UPDATE invoices SET subtotal = $1, tax = $2, total = $3 WHERE id = $4`,
      [subtotal, tax, total, invoiceId]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Invoice created successfully', invoice_id: invoiceId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating invoice:', err);
    res.status(500).json({ error: 'Server error generating invoice' });
  } finally {
    client.release();
  }
});

app.get('/api/invoices', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.*, v.plate, v.owner
      FROM invoices i
      JOIN vehicles v ON i.vehicle_id = v.id
      ORDER BY i.id DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching invoices:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/invoices/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: invoiceRows } = await pool.query(
      `SELECT i.*, v.plate, v.owner
       FROM invoices i
       JOIN vehicles v ON i.vehicle_id = v.id
       WHERE i.id = $1`,
      [id]
    );
    if (invoiceRows.length === 0) return res.status(404).json({ error: 'Invoice not found' });

    const { rows: items } = await pool.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC`,
      [id]
    );
    res.json({ invoice: invoiceRows[0], items });
  } catch (err) {
    console.error('Error fetching invoice:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Invoice PDF
app.get('/api/invoices/:id/pdf', async (req, res) => {
  
  try {
    const { id } = req.params;

    const invRes = await pool.query(
      `
      SELECT
        i.id, i.vehicle_id, i.days_in_garage, i.garage_stay_rate, i.subtotal, i.tax, i.total,
        v.plate, v.owner, v.model_name, v.make, v.year, v.vin, v.contact_number
      FROM invoices i
      LEFT JOIN vehicles v ON v.id = i.vehicle_id
      WHERE i.id = $1
      LIMIT 1
      `,
      [id]
    );
    if (invRes.rowCount === 0) return res.status(404).json({ error: 'Invoice not found' });
    const r = invRes.rows[0];

    const itemsRes = await pool.query(
      `SELECT id, item_type, description, quantity, unit_price, total
       FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC`,
      [id]
    );
    const items = itemsRes.rows || [];

    const rwf = new Intl.NumberFormat('en-RW', {
      style: 'currency',
      currency: 'RWF',
      maximumFractionDigits: 0,
    });

    const garageStayTotal = Number(r.days_in_garage || 0) * Number(r.garage_stay_rate || 0);
    const subtotalRWF = Number(r.subtotal || 0);
    const taxRWF = Math.round(subtotalRWF * 0.18);
    const totalRWF = subtotalRWF + taxRWF;

    res.setHeader('Content-Disposition', `attachment; filename="invoice_${id}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

   // Header
drawPdfHeader(doc, `Invoice #${r.id}`);


    // Meta
    doc.text(`Vehicle Plate: ${r.plate || '-'}`);
    doc.text(`Customer: ${r.owner || '-'}`);
    if (r.contact_number) doc.text(`Contact: ${r.contact_number}`);
    if (r.model_name) doc.text(`Model: ${r.model_name}`);
    const makeYear = [r.make, r.year].filter(Boolean).join(' • ');
    if (makeYear) doc.text(`Make/Year: ${makeYear}`);
    if (r.vin) doc.text(`VIN: ${r.vin}`);
    doc.text(`Days in Garage: ${r.days_in_garage || 0}`);
    doc.text(`Garage Stay Rate: ${rwf.format(Number(r.garage_stay_rate || 0))}`);
    doc.moveDown(0.8);

    // Items table
    doc.fontSize(12).text('Items', { underline: true });
    doc.moveDown(0.4);
    const cols = { type: 50, desc: 120, qty: 360, unit: 420, tot: 500 };
    doc.fontSize(11);
    doc.text('Type', cols.type, doc.y);
    doc.text('Description', cols.desc, doc.y, { width: 220 });
    doc.text('Qty', cols.qty, doc.y);
    doc.text('Unit (RWF)', cols.unit, doc.y);
    doc.text('Total (RWF)', cols.tot, doc.y);
    doc.moveDown(0.2);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.4);

    items.forEach(it => {
      const y = doc.y;
      doc.text(it.item_type || '-', cols.type, y);
      doc.text(it.description || '-', cols.desc, y, { width: 220 });
      doc.text(String(it.quantity ?? ''), cols.qty, y);
      doc.text(rwf.format(Number(it.unit_price || 0)), cols.unit, y);
      doc.text(rwf.format(Number(it.total || 0)), cols.tot, y);
      doc.moveDown(0.3);
    });

    // Totals
    doc.moveDown(0.8);
    const rightCol = 400;
    doc.fontSize(12);
    doc.text(`Garage Stay: ${rwf.format(garageStayTotal)}`, rightCol, doc.y, { align: 'right' });
    doc.moveDown(0.2);
    doc.text(`Subtotal: ${rwf.format(subtotalRWF)}`, rightCol, doc.y, { align: 'right' });
    doc.moveDown(0.2);
    doc.text(`Tax (18%): ${rwf.format(taxRWF)}`, rightCol, doc.y, { align: 'right' });
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').text(`Total: ${rwf.format(totalRWF)}`, rightCol, doc.y, { align: 'right' });
    doc.font('Helvetica');

    doc.end();
  } catch (err) {
    console.error('Error generating invoice PDF:', err);
    res.status(500).json({ error: 'Server error generating PDF' });
  }
});

// ---------- WORKER PAYMENTS ----------
app.get('/api/workers/:id/payments', async (req, res) => {
  try {
    const { id } = req.params;

    const w = await pool.query('SELECT * FROM workers WHERE id = $1', [id]);
    if (w.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });

    const pay = await pool.query(
      `SELECT id, worker_id, amount, method, notes, payment_date
       FROM worker_payments
       WHERE worker_id = $1
       ORDER BY payment_date DESC NULLS LAST, id DESC`,
      [id]
    );
    const payments = pay.rows;
    const total = payments.reduce((s, p) => s + Number(p.amount || 0), 0);

    res.json({ worker: w.rows[0], payments, total });
  } catch (err) {
    console.error('Error fetching worker payments:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/workers/:id/payments', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { amount, method, notes, payment_date } = req.body;

    if (!amount || isNaN(Number(amount))) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Accept YYYY-MM-DD or ISO datetime; if invalid, default to NOW()
    let when = null;
    if (payment_date) {
      const parsed = new Date(payment_date);
      if (!isNaN(parsed.getTime())) when = parsed;
    }

    const q = `
      INSERT INTO worker_payments (worker_id, amount, method, notes, payment_date)
      VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
      RETURNING id, worker_id, amount, method, notes, payment_date
    `;
    const vals = [id, Number(amount), method || null, notes || null, when];

    const { rows } = await client.query(q, vals);
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Add payment error:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.get('/api/workers/:id/payments/total', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM worker_payments WHERE worker_id = $1',
      [id]
    );
    res.json({ total_paid: Number(rows[0].total_paid || 0) });
  } catch (err) {
    console.error('Error calculating total payment:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/workers/:id/payments/pdf', async (req, res) => {
  try {
    const { id } = req.params;

    const workerRes = await pool.query('SELECT * FROM workers WHERE id = $1', [id]);
    if (workerRes.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });
    const worker = workerRes.rows[0];

    const payRes = await pool.query(
      `SELECT id, amount, method, notes, payment_date
       FROM worker_payments
       WHERE worker_id = $1
       ORDER BY payment_date DESC NULLS LAST, id DESC`,
      [id]
    );
    const payments = payRes.rows;
    const total = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

    const safeName = (worker.name || 'worker').replace(/\s+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_payments.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    // Title
    doc.fontSize(18).text('Worker Payment Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Worker: ${worker.name || ''} (ID: ${worker.id})`);
    if (worker.job_title) doc.text(`Job Title: ${worker.job_title}`);
    if (worker.phone) doc.text(`Phone: ${worker.phone}`);
    if (worker.email) doc.text(`Email: ${worker.email}`);
    doc.text(`Generated: ${new Date().toLocaleString()}`);
    doc.moveDown(1);

    // Table
    doc.fontSize(12).text('Payments', { underline: true });
    doc.moveDown(0.5);
    const cols = { date: 50, amount: 180, method: 280, notes: 380 };
    doc.fontSize(11).text('Date/Time', cols.date, doc.y);
    doc.text('Amount', cols.amount, doc.y);
    doc.text('Method', cols.method, doc.y);
    doc.text('Notes', cols.notes, doc.y);
    doc.moveDown(0.2);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.4);

    payments.forEach(p => {
      const y = doc.y;
      const dt = p.payment_date ? new Date(p.payment_date).toLocaleString() : '';
      doc.text(dt, cols.date, y, { width: 120 });
      doc.text(
        Number(p.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 }),
        cols.amount,
        y,
        { width: 90 }
      );
      doc.text(p.method || '-', cols.method, y, { width: 90 });
      doc.text(p.notes || '-', cols.notes, y, { width: 160 });
      doc.moveDown(0.4);
    });

    doc.moveDown(1);
    doc.fontSize(12).text(
      `Total Paid: ${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
      { align: 'right' }
    );

    doc.end();
  } catch (err) {
    console.error('Error generating PDF:', err);
    res.status(500).json({ error: 'Server error generating PDF' });
  }
});

// ---------- ARCHIVE UPLOADS ----------
app.post('/api/archive/files', upload.array('files', 20), (req, res) => {
  const year = String(req.body.year || '').trim();
  const files = (req.files || []).map(f => ({
    originalName: f.originalname,
    filename: path.basename(f.path),
    url: `/uploads/invoices/${year}/${path.basename(f.path)}`,
    size: f.size,
    mimetype: f.mimetype,
  }));
  res.json({ ok: true, year, files });
});

app.get('/api/archive/files/:year', (req, res) => {
  const { year } = req.params;
  if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'Invalid year' });

  const dir = path.join(INVOICE_DIR, year);
  if (!fs.existsSync(dir)) return res.json({ year, files: [] });

  const items = fs.readdirSync(dir).map(name => ({
    name,
    url: `/uploads/invoices/${year}/${name}`,
  }));
  res.json({ year, files: items });
});
// Delete vehicle (cascade invoices + items first)
app.delete('/api/vehicles/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    // Delete invoice items of invoices tied to this vehicle
    await client.query(
      `DELETE FROM invoice_items 
       WHERE invoice_id IN (SELECT id FROM invoices WHERE vehicle_id = $1)`,
      [id]
    );

    // Delete invoices of this vehicle
    await client.query(`DELETE FROM invoices WHERE vehicle_id = $1`, [id]);

    // Finally delete vehicle
    const result = await client.query(`DELETE FROM vehicles WHERE id = $1 RETURNING id`, [id]);

    await client.query('COMMIT');
    if (result.rowCount === 0) return res.status(404).json({ error: 'Vehicle not found' });
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting vehicle:', err);
    res.status(500).json({ error: 'Server error deleting vehicle' });
  } finally {
    client.release();
  }
});

// Delete invoice (cascade invoice items first)
app.delete('/api/invoices/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
    const result = await client.query(`DELETE FROM invoices WHERE id = $1 RETURNING id`, [id]);

    await client.query('COMMIT');
    if (result.rowCount === 0) return res.status(404).json({ error: 'Invoice not found' });
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting invoice:', err);
    res.status(500).json({ error: 'Server error deleting invoice' });
  } finally {
    client.release();
  }
});

// ---------- MISC ----------
app.get('/api/vehicle-ids', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, plate, owner FROM vehicles ORDER BY id DESC`);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching vehicle IDs:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
