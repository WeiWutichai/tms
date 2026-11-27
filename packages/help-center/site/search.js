(function(){var box=document.getElementById('q'),out=document.getElementById('results');if(!box||!out)return;var sel=-1;
function norm(s){return (s||'').toLowerCase().normalize('NFC')}
function run(){var q=norm(box.value).trim();out.innerHTML='';sel=-1;if(!q){out.classList.remove('on');return}
var terms=q.split(/\s+/),idx=window.HELP_INDEX||[],hits=[];
for(var i=0;i<idx.length;i++){var d=idx[i],t=norm(d.t),b=norm(d.b),ok=true,score=0;
for(var j=0;j<terms.length;j++){var w=terms[j];if(t.indexOf(w)>=0)score+=10;else if(b.indexOf(w)>=0)score+=1;else{ok=false;break}}
if(ok)hits.push([score,i])}
hits.sort(function(a,b){return b[0]-a[0]||a[1]-b[1]});
if(!hits.length){out.innerHTML='<div class="none">ไม่พบผลลัพธ์ ลองใช้คำอื่น</div>'}
hits.slice(0,12).forEach(function(h){var d=idx[h[1]],a=document.createElement('a');a.href=d.u;a.textContent=d.t;var s=document.createElement('small');s.textContent=d.g;a.appendChild(s);out.appendChild(a)});
out.classList.add('on')}
box.addEventListener('input',run);
box.addEventListener('keydown',function(e){var as=out.querySelectorAll('a');if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(!as.length)return;sel=(sel+(e.key==='ArrowDown'?1:-1)+as.length)%as.length;as.forEach(function(a,k){a.classList.toggle('sel',k===sel)})}else if(e.key==='Enter'){var t=as[sel>=0?sel:0];if(t)location.href=t.href}else if(e.key==='Escape'){out.classList.remove('on')}});
document.addEventListener('click',function(e){if(!e.target.closest||!e.target.closest('.search'))out.classList.remove('on')});
})();
