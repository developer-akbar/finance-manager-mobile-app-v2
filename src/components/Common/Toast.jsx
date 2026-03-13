import React, { useState, useCallback } from 'react';
let _add = null;
export const toast = { success:(m)=>_add?.(m,'success'), error:(m)=>_add?.(m,'error'), info:(m)=>_add?.(m,'info') };
export default function Toast() {
  const [toasts, setToasts] = useState([]);
  _add = useCallback((msg,type='info') => {
    const id=Date.now(); setToasts(t=>[...t,{id,msg,type}]);
    setTimeout(()=>setToasts(t=>t.filter(x=>x.id!==id)),3000);
  },[]);
  return (
    <div className="toast-container">
      {toasts.map(t=><div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>)}
    </div>
  );
}
