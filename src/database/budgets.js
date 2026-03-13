import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

export const getBudgets   = async () => { const r=await getDB().query('SELECT * FROM budgets ORDER BY category'); return r.values||[]; };
export const setBudget    = async (category,amount,period='monthly') => { const db=getDB(); const ex=await db.query('SELECT id FROM budgets WHERE category=?',[category]); if(ex.values?.length>0){await db.run('UPDATE budgets SET amount=?,period=? WHERE category=?',[amount,period,category]);}else{await db.run('INSERT INTO budgets (id,category,amount,period,created_at) VALUES (?,?,?,?,?)',[uuid(),category,amount,period,new Date().toISOString()]);} };
export const deleteBudget = async (category) => { await getDB().run('DELETE FROM budgets WHERE category=?',[category]); };
