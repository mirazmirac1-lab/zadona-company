const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------- Startup: ensure schema exists ----------
async function ensureSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Schema ready.');
}

// ---------- Helpers ----------
function mapSaleRow(r) {
  return {
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    qty: r.qty,
    total: Number(r.total),
    paidAmount: Number(r.paid_amount),
    debtorName: r.debtor_name || '',
    debtorPhone: r.debtor_phone || '',
    agentId: r.agent_id || null,
    date: r.sale_date
  };
}

function mapItemRow(r) {
  return { id: r.id, name: r.name, qty: r.qty, price: Number(r.price), ownerId: r.owner_id || null };
}

function mapUserRow(r) {
  return { id: r.id, fullName: r.full_name, phone: r.phone, role: r.role, approvalStatus: r.approval_status || 'pending' };
}

function mapCompanyProfile(r) {
  return {
    id: r.id,
    companyName: r.company_name,
    address: r.address || '',
    phone: r.phone || '',
    ownerName: r.owner_name || '',
    notes: r.notes || ''
  };
}

function mapExpenseRow(r) {
  return {
    id: r.id,
    description: r.description,
    amount: Number(r.amount),
    category: r.category,
    expenseDate: r.expense_date,
    notes: r.notes || ''
  };
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function isZaudiaAccount(fullName) {
  return normalizeName(fullName) === 'zaudia';
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const [scheme, encoded] = auth.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const [phone, password] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  if (!phone || !password) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  req.auth = { phone, password };
  next();
}

async function getAuthenticatedUser(req) {
  const { phone, password } = req.auth;
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE phone = $1 AND password_hash = $2',
    [phone, hashPassword(password)]
  );
  return rows[0] || null;
}

async function requireRole(req, res, next) {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
  req.user = user;
  next();
}

async function requireHeadquarter(req, res, next) {
  await requireRole(req, res, async () => {
    if (req.user.role !== 'headquarter') {
      return res.status(403).json({ error: 'Only headquarter can access this area' });
    }
    next();
  });
}

// Password reset storage (temporary codes expire after 30 minutes)
const passwordResetCodes = {};

function generateResetCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanExpiredCodes() {
  const now = Date.now();
  for (const phone in passwordResetCodes) {
    if (now - passwordResetCodes[phone].timestamp > 30 * 60 * 1000) {
      delete passwordResetCodes[phone];
    }
  }
}

// ---------- Auth routes ----------
app.post('/api/login', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    if (user.approval_status !== 'approved') {
      return res.status(403).json({ error: 'Account is pending approval by Zaudia' });
    }
    res.json({ user: mapUserRow(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kuthibitisha' });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    let actingUser = null;

    if (authHeader) {
      const [scheme, encoded] = authHeader.split(' ');
      if (scheme === 'Basic' && encoded) {
        const [phone, password] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
        if (phone && password) {
          const { rows } = await pool.query(
            'SELECT * FROM users WHERE phone = $1 AND password_hash = $2',
            [phone, hashPassword(password)]
          );
          actingUser = rows[0] || null;
        }
      }
    }

    const { fullName, phone, password, role = 'agent' } = req.body;
    const trimmedName = String(fullName || '').trim();
    if (!trimmedName || !phone || !password) {
      return res.status(400).json({ error: 'Jina, namba ya simu na password zinahitajika' });
    }
    if (!['headquarter', 'agent'].includes(role)) {
      return res.status(400).json({ error: 'Role is not supported' });
    }

    const isSelfRegistration = !actingUser;
    const approvalStatus = 'approved';

    if (!isSelfRegistration && (actingUser.role !== 'headquarter' || actingUser.approval_status !== 'approved')) {
      return res.status(403).json({ error: 'Only approved headquarter can create accounts' });
    }

    const { rows } = await pool.query(
      'INSERT INTO users (full_name, phone, password_hash, role, approval_status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [trimmedName, phone, hashPassword(password), role, approvalStatus]
    );
    res.status(201).json(mapUserRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kuunda mtumiaji' });
  }
});

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    if (user.role !== 'headquarter' || user.approval_status !== 'approved') return res.status(403).json({ error: 'Only approved headquarter can view accounts' });
    const { rows } = await pool.query('SELECT * FROM users ORDER BY id');
    res.json(rows.map(mapUserRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kupata watumiaji' });
  }
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Nywila ya sasa na mpya zinahitajika' });
    }
    if (hashPassword(currentPassword) !== user.password_hash) {
      return res.status(401).json({ error: 'Nywila ya sasa si sahihi' });
    }
    if (String(newPassword).length < 4) {
      return res.status(400).json({ error: 'Nywila mpya lazima iwe na herufi 4 au zaidi' });
    }
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kubadilisha nywila' });
  }
});

app.post('/api/forgot-password', async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) {
      return res.status(400).json({ error: 'Namba ya simu inahitajika' });
    }
    
    const { rows } = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (rows.length === 0) {
      // Don't reveal if phone doesn't exist
      return res.json({ message: 'If phone exists, a reset code will be sent' });
    }

    cleanExpiredCodes();
    const code = generateResetCode();
    passwordResetCodes[phone] = { code, timestamp: Date.now() };

    // In production, this would be sent via SMS. For now, return it in response.
    res.json({ message: 'Reset code sent', resetCode: code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kutuma reset code' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { phone, resetCode, newPassword } = req.body || {};
    if (!phone || !resetCode || !newPassword) {
      return res.status(400).json({ error: 'Namba ya simu, reset code, na nywila mpya zinahitajika' });
    }

    if (String(newPassword).length < 4) {
      return res.status(400).json({ error: 'Nywila mpya lazima iwe na herufi 4 au zaidi' });
    }

    cleanExpiredCodes();
    const stored = passwordResetCodes[phone];
    if (!stored || stored.code !== resetCode) {
      return res.status(401).json({ error: 'Reset code si sahihi au umeishia muda' });
    }

    const { rows } = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Mtumiaji haipo' });
    }

    await pool.query('UPDATE users SET password_hash = $1 WHERE phone = $2', [hashPassword(newPassword), phone]);
    delete passwordResetCodes[phone];
    res.json({ success: true, message: 'Nywila imebadilishwa' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kubadilisha nywila' });
  }
});

app.post('/api/users/:id/approve', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    if (user.role !== 'headquarter' || user.approval_status !== 'approved' || !isZaudiaAccount(user.full_name)) {
      return res.status(403).json({ error: 'Only Zaudia can approve accounts' });
    }
    const { rows } = await pool.query(
      'UPDATE users SET approval_status = $1 WHERE id = $2 RETURNING *',
      ['approved', req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    res.json({ user: mapUserRow(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kuapprove akaunti' });
  }
});

app.get('/api/agents/:id/inventory', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    if (user.role !== 'headquarter' || user.approval_status !== 'approved') return res.status(403).json({ error: 'Only approved headquarter can view agent inventory' });
    const { rows } = await pool.query('SELECT * FROM inventory WHERE owner_id = $1 ORDER BY id', [req.params.id]);
    res.json(rows.map(mapItemRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kupata taarifa za wakala' });
  }
});

// ---------- Inventory routes ----------
app.get('/api/inventory', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    let query = 'SELECT * FROM inventory';
    let params = [];
    if (user.role === 'agent') {
      query += ' WHERE owner_id IS NULL OR owner_id = $1';
      params.push(user.id);
    }
    query += ' ORDER BY id';
    const { rows } = await pool.query(query, params);
    res.json(rows.map(mapItemRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kupata bidhaa' });
  }
});

app.post('/api/inventory', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    if (user.role !== 'agent' && user.role !== 'headquarter') {
      return res.status(403).json({ error: 'Role not allowed' });
    }
    const { name, qty, price } = req.body;
    if (!name) return res.status(400).json({ error: 'Jina la bidhaa linahitajika' });
    const { rows } = await pool.query(
      'INSERT INTO inventory (name, qty, price, owner_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, qty || 0, price || 0, user.role === 'agent' ? user.id : null]
    );
    res.status(201).json(mapItemRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kuongeza bidhaa' });
  }
});

// Adjust stock (add or subtract qty)
app.patch('/api/inventory/:id/stock', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    const { delta } = req.body;
    const existing = await pool.query('SELECT * FROM inventory WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Bidhaa haipo' });
    if (user.role === 'agent' && existing.rows[0].owner_id !== user.id) {
      return res.status(403).json({ error: 'Unaweza kubadilisha bidhaa zako tu' });
    }
    const { rows } = await pool.query(
      'UPDATE inventory SET qty = qty + $1 WHERE id = $2 RETURNING *',
      [delta, req.params.id]
    );
    res.json(mapItemRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kubadilisha stock' });
  }
});

app.delete('/api/inventory/:id', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    const existing = await pool.query('SELECT * FROM inventory WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Bidhaa haipo' });
    if (user.role === 'agent' && existing.rows[0].owner_id !== user.id) {
      return res.status(403).json({ error: 'Unaweza kufuta bidhaa zako tu' });
    }
    await pool.query('DELETE FROM inventory WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kufuta bidhaa' });
  }
});

app.patch('/api/inventory/:id/assign', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    if (user.role !== 'headquarter' || user.approval_status !== 'approved') {
      return res.status(403).json({ error: 'Only approved headquarter can assign inventory' });
    }
    const { agentId, scope } = req.body || {};
    const normalizedAgentId = agentId ? Number(agentId) : null;
    const normalizedScope = scope === 'company' ? 'company' : 'agent';

    if (normalizedScope === 'agent' && normalizedAgentId !== null) {
      const agentRes = await pool.query('SELECT id, role FROM users WHERE id = $1', [normalizedAgentId]);
      if (agentRes.rows.length === 0 || agentRes.rows[0].role !== 'agent') {
        return res.status(400).json({ error: 'Agent si sahihi' });
      }
    }

    const ownerId = normalizedScope === 'company' ? null : normalizedAgentId;
    const { rows } = await pool.query(
      'UPDATE inventory SET owner_id = $1 WHERE id = $2 RETURNING *',
      [ownerId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Bidhaa haipo' });
    res.json(mapItemRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kupa agent bidhaa' });
  }
});

// ---------- Sales routes ----------
app.get('/api/sales', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    let query = 'SELECT * FROM sales';
    const params = [];
    if (user.role === 'agent') {
      query += ' WHERE agent_id = $1';
      params.push(user.id);
    }
    query += ' ORDER BY sale_date DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows.map(mapSaleRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kupata mauzo' });
  }
});

// Create a sale: decrements stock and records the sale in one transaction
app.post('/api/sales', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    const { itemId, qty, debtorName, debtorPhone, paidCash } = req.body;
    if (!itemId || !qty || qty <= 0) {
      return res.status(400).json({ error: 'Chagua bidhaa na idadi sahihi' });
    }
    await client.query('BEGIN');

    const itemRes = await client.query('SELECT * FROM inventory WHERE id = $1 FOR UPDATE', [itemId]);
    if (itemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bidhaa haipo' });
    }
    const item = itemRes.rows[0];
    if (qty > item.qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Stock haitoshi' });
    }

    const total = Number(item.price) * qty;
    const paidAmount = paidCash ? total : 0;

    await client.query('UPDATE inventory SET qty = qty - $1 WHERE id = $2', [qty, itemId]);

    const saleRes = await client.query(
      `INSERT INTO sales (item_id, item_name, qty, total, paid_amount, debtor_name, debtor_phone, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [itemId, item.name, qty, total, paidAmount, debtorName || null, debtorPhone || null, user.id]
    );

    await client.query('COMMIT');
    res.status(201).json(mapSaleRow(saleRes.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kurekodi mauzo' });
  } finally {
    client.release();
  }
});

// Mark a single sale fully paid
app.patch('/api/sales/:id/mark-paid', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    let query = 'UPDATE sales SET paid_amount = total WHERE id = $1';
    const params = [req.params.id];
    if (user.role === 'agent') {
      query += ' AND agent_id = $2';
      params.push(user.id);
    }
    query += ' RETURNING *';
    const { rows } = await pool.query(query, params);
    if (rows.length === 0) return res.status(404).json({ error: 'Mauzo hayapo' });
    res.json(mapSaleRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kusasisha malipo' });
  }
});

// Apply a partial/full payment across a debtor's oldest unpaid sales first
app.post('/api/debts/pay', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    const { debtorName, amount } = req.body;
    if (!debtorName || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Andika jina na kiasi sahihi' });
    }
    await client.query('BEGIN');
    const query = user.role === 'agent'
      ? `SELECT * FROM sales WHERE lower(debtor_name) = lower($1) AND paid_amount < total AND agent_id = $2 ORDER BY sale_date ASC FOR UPDATE`
      : `SELECT * FROM sales WHERE lower(debtor_name) = lower($1) AND paid_amount < total ORDER BY sale_date ASC FOR UPDATE`;
    const params = user.role === 'agent' ? [debtorName, user.id] : [debtorName];
    const { rows } = await client.query(query, params);
    let remainingPayment = Number(amount);
    for (const sale of rows) {
      if (remainingPayment <= 0) break;
      const owed = Number(sale.total) - Number(sale.paid_amount);
      const applied = Math.min(owed, remainingPayment);
      await client.query('UPDATE sales SET paid_amount = paid_amount + $1 WHERE id = $2', [applied, sale.id]);
      remainingPayment -= applied;
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kurekodi malipo' });
  } finally {
    client.release();
  }
});

// Mark all of a debtor's sales as fully paid
app.post('/api/debts/pay-all', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    const { debtorName } = req.body;
    if (!debtorName) return res.status(400).json({ error: 'Jina la mteja linahitajika' });
    if (user.role === 'agent') {
      await pool.query(
        'UPDATE sales SET paid_amount = total WHERE lower(debtor_name) = lower($1) AND agent_id = $2',
        [debtorName, user.id]
      );
    } else {
      await pool.query(
        'UPDATE sales SET paid_amount = total WHERE lower(debtor_name) = lower($1)',
        [debtorName]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kukamilisha malipo' });
  }
});

// ---------- Company profile & expenses ----------
app.get('/api/company', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    const { rows } = await pool.query('SELECT * FROM company_profile ORDER BY id DESC LIMIT 1');
    if (rows.length === 0) {
      return res.json({ company: null });
    }
    res.json({ company: mapCompanyProfile(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kupata taarifa ya kampuni' });
  }
});

app.post('/api/company', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    if (user.role !== 'headquarter') return res.status(403).json({ error: 'Only headquarter can update company details' });
    const { companyName, address, phone, ownerName, notes } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO company_profile (company_name, address, phone, owner_name, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [companyName || 'Zadona', address || '', phone || '', ownerName || '', notes || '']
    );
    res.status(201).json({ company: mapCompanyProfile(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kusasisha taarifa ya kampuni' });
  }
});

app.get('/api/expenses', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    const { rows } = await pool.query('SELECT * FROM expenses ORDER BY expense_date DESC, id DESC');
    res.json(rows.map(mapExpenseRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kupata matumizi' });
  }
});

app.get('/api/reports/summary', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    if (user.role !== 'headquarter') return res.status(403).json({ error: 'Only headquarter can view reports' });
    const [salesRes, expensesRes] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(total), 0)::numeric AS revenue FROM sales'),
      pool.query('SELECT COALESCE(SUM(amount), 0)::numeric AS expenses FROM expenses')
    ]);
    const revenue = Number(salesRes.rows[0].revenue || 0);
    const spend = Number(expensesRes.rows[0].expenses || 0);
    res.json({ revenue, expenses: spend, profit: revenue - spend });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kupata ripoti' });
  }
});

app.post('/api/expenses', requireAuth, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Invalid phone or password' });
    if (user.role !== 'headquarter') return res.status(403).json({ error: 'Only headquarter can record expenditures' });
    const { description, amount, category, expenseDate, notes } = req.body;
    if (!description || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Maelezo na kiasi vinahitajika' });
    }
    const { rows } = await pool.query(
      `INSERT INTO expenses (description, amount, category, expense_date, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [description, amount, category || 'Resources', expenseDate || new Date().toISOString().slice(0, 10), notes || '']
    );
    res.status(201).json(mapExpenseRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Imeshindwa kurekodi matumizi' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

async function seedDefaultCompany() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM company_profile');
  if (rows[0].count > 0) return;
  await pool.query(
    `INSERT INTO company_profile (company_name, address, phone, owner_name, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    ['Zadona', 'Dar es Salaam', '255700000000', 'Headquarter', 'Main company profile']
  );
}

async function seedDefaultUsers() {
  const headquarterPhone = '0718278600';
  const legacyHeadquarterPhone = '255700000000';
  const agentPhone = '255700000001';
  const headquarterPassword = 'zaudia';
  const agentPassword = 'agent123';

  const existing = await pool.query(
    'SELECT * FROM users WHERE phone IN ($1, $2) OR full_name ILIKE $3',
    [headquarterPhone, legacyHeadquarterPhone, '%zaudia%']
  );
  if (existing.rows.length > 0) {
    await pool.query(
      'UPDATE users SET full_name = $1, phone = $2, password_hash = $3, role = $4, approval_status = $5 WHERE id = $6',
      ['Zaudia dadi', headquarterPhone, hashPassword(headquarterPassword), 'headquarter', 'approved', existing.rows[0].id]
    );
    return;
  }

  const otherUsers = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (otherUsers.rows[0].count > 0) {
    await pool.query(
      'INSERT INTO users (full_name, phone, password_hash, role, approval_status) VALUES ($1, $2, $3, $4, $5)',
      ['Zaudia dadi', headquarterPhone, hashPassword(headquarterPassword), 'headquarter', 'approved']
    );
    return;
  }

  await pool.query(
    'INSERT INTO users (full_name, phone, password_hash, role, approval_status) VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)',
    [
      'Zaudia dadi', headquarterPhone, hashPassword(headquarterPassword), 'headquarter', 'approved',
      'Agent One', agentPhone, hashPassword(agentPassword), 'agent', 'approved'
    ]
  );
}

ensureSchema()
  .then(seedDefaultCompany)
  .then(seedDefaultUsers)
  .then(() => {
    app.listen(PORT, () => console.log(`Zadona running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize schema:', err);
    process.exit(1);
  });
