const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-this-secret-before-deploying-please';
const dbFile = process.env.DATABASE_FILE || './data/party.sqlite';
fs.mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '🎮', xp INTEGER NOT NULL DEFAULT 0,
 rating INTEGER NOT NULL DEFAULT 1000, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
 played INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS matches (
 id TEXT PRIMARY KEY, game TEXT NOT NULL, room_code TEXT NOT NULL, winner_id INTEGER,
 participants_json TEXT NOT NULL, scores_json TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(winner_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS reward_transactions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, user_id INTEGER NOT NULL,
 xp_delta INTEGER NOT NULL, rating_delta INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(match_id,user_id), FOREIGN KEY(match_id) REFERENCES matches(id), FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_matches_finished ON matches(finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_rating ON users(rating DESC);
`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, pingInterval: 25000, pingTimeout: 20000 });
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));

const games = {
 auction: { name: 'مزاد الأسئلة', en: 'Auction Quiz', desc: 'زايد بعدد الأسئلة التي تقدر تجاوبها.', players: '3–8', difficulty: 'متوسط', time: '10–20 دقيقة', xp: 100 },
 xo: { name: 'إكس أو', en: 'Tic-Tac-Toe', desc: 'تحدّ صديقك في مواجهة مباشرة.', players: '2', difficulty: 'سهل', time: '2–5 دقائق', xp: 50 },
 madgab: { name: 'مداقش', en: 'Guess the Phrase', desc: 'اقرأ العبارة الغريبة واكتشف المقصود.', players: '2–10', difficulty: 'متوسط', time: '5–15 دقيقة', xp: 100 },
 codenames: { name: 'كود نيمز', en: 'Codenames', desc: 'تعاون مع فريقك واكتشف الكلمات السرية.', players: '4–10', difficulty: 'صعب', time: '10–25 دقيقة', xp: 175 }
};
const questions = [
 {q:'كم عدد لاعبي الفريق داخل الملعب في كرة القدم؟',a:'11',cat:'كرة القدم'},
 {q:'ما الدولة التي فازت بكأس العالم 2022؟',a:'الأرجنتين',cat:'كرة القدم'},
 {q:'كم عدد ألوان قوس قزح التقليدية؟',a:'7',cat:'معلومات عامة'},
 {q:'ما عاصمة اليابان؟',a:'طوكيو',cat:'جغرافيا'},
 {q:'ما الكوكب المعروف بالكوكب الأحمر؟',a:'المريخ',cat:'علوم'},
 {q:'كم ضلعًا للمثلث؟',a:'3',cat:'معلومات عامة'},
 {q:'في أي لعبة توجد خريطة Erangel؟',a:'PUBG',cat:'ألعاب'},
 {q:'ما أكبر محيط في العالم؟',a:'المحيط الهادئ',cat:'جغرافيا'},
 {q:'كم دقيقة في ساعتين؟',a:'120',cat:'معلومات عامة'},
 {q:'ما الحيوان المعروف بسفينة الصحراء؟',a:'الجمل',cat:'معلومات عامة'},
 {q:'ما عاصمة المملكة العربية السعودية؟',a:'الرياض',cat:'جغرافيا'},
 {q:'كم لاعبًا في فريق كرة السلة داخل الملعب؟',a:'5',cat:'رياضة'}
];
const phrases = [
 {phrase:'عين شمس', answer:'عين شمس', hint:'شيء تراه في السماء'},
 {phrase:'بابا غنوج', answer:'بابا غنوج', hint:'طبق معروف'},
 {phrase:'سيف البحر', answer:'سيف البحر', hint:'قريب من الماء'},
 {phrase:'قلب الطاولة', answer:'قلب الطاولة', hint:'تعبير مجازي'},
 {phrase:'فارس الأحلام', answer:'فارس الأحلام', hint:'شخصية في القصص'},
 {phrase:'قطار سريع', answer:'قطار سريع', hint:'وسيلة نقل'},
 {phrase:'كوكب زمردة', answer:'كوكب زمردة', hint:'اسم خيالي'}
];
const words = ['قمر','مفتاح','نخلة','مطر','قلعة','قهوة','صقر','بحر','ساعة','كتاب','سيارة','نجمة','حديقة','جبل','باب','سفينة','موسيقى','مدينة','نهر','هاتف','تفاحة','كرسي','شمس','مطار','كرة'];
const rooms = new Map();
const socketsByUser = new Map();
const uid = () => require('crypto').randomUUID();
const code = () => Math.random().toString(36).slice(2, 7).toUpperCase();
function publicUser(row) { return { id: row.id, username: row.username, avatar: row.avatar, xp: row.xp, rating: row.rating, wins: row.wins, losses: row.losses, played: row.played, level: Math.floor(row.xp / 250) + 1, rank: rankFor(row.rating) }; }
function rankFor(r) { return r >= 2200 ? 'Legend' : r >= 1900 ? 'Master' : r >= 1650 ? 'Diamond' : r >= 1400 ? 'Platinum' : r >= 1200 ? 'Gold' : r >= 1050 ? 'Silver' : 'Bronze'; }
function tokenFor(user) { return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '14d' }); }
function auth(req, res, next) {
 const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.cookies.session;
 if (!token) return res.status(401).json({ error: 'سجّل الدخول أولًا' });
 try { req.user = jwt.verify(token, JWT_SECRET); next(); } catch { res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول مجددًا' }); }
}
function roomPublic(r) { return { id:r.id, code:r.code, hostId:r.hostId, hostName:r.hostName, game:r.game, status:r.status, maxPlayers:r.maxPlayers, guestAccess:r.guestAccess, players:r.players.map(p=>({id:p.id, username:p.username, avatar:p.avatar, ready:p.ready, connected:p.connected, isHost:p.id===r.hostId})), chat:r.chat.slice(-40), state:(r.status==='playing'||r.status==='finished')?publicGameState(r):null, createdAt:r.createdAt }; }
function publicGameState(r) {
 const s = r.state || {};
 if (r.game === 'codenames' && s.board) {
  const player = null;
  return { ...s, board: s.board.map(c=>({word:c.word, revealed:c.revealed, color:c.revealed?c.color:null})), hidden:true };
 }
 if (r.game === 'auction' && s.currentQuestion) return { ...s, currentQuestion:{q:s.currentQuestion.q, cat:s.currentQuestion.cat} };
 return s;
}
function emitRoom(r) { io.to(r.id).emit('room:update', roomPublic(r)); }
function safeRoom(r, userId) {
 const view = roomPublic(r);
 if (r.game === 'codenames' && r.state?.board) {
  const p = r.players.find(x=>x.id===userId);
  view.state.board = r.state.board.map(c=>({ word:c.word, revealed:c.revealed, color:c.revealed ? c.color : (p && (p.id===r.state.captains?.red || p.id===r.state.captains?.blue) ? c.color : null) }));
  view.state.isCaptain = !!p && [r.state.captains?.red,r.state.captains?.blue].includes(p.id);
  view.state.team = r.state.teams?.[userId] || null;
 }
 if (r.game === 'auction' && r.state?.currentQuestion) view.state.currentQuestion = {q:r.state.currentQuestion.q,cat:r.state.currentQuestion.cat,answer: r.state.currentPlayerId===userId ? r.state.currentQuestion.a : undefined};
 return view;
}
function emitPersonalRoom(r) { for (const p of r.players) { const s = socketsByUser.get(p.id); if(s) for(const sid of s) io.to(sid).emit('room:update', safeRoom(r,p.id)); } }
function findRoom(idOrCode) { const key=String(idOrCode||'').toUpperCase(); return rooms.get(key) || [...rooms.values()].find(r=>r.code===key); }
function addPlayer(r, player) {
 if(r.players.some(p=>p.id===player.id)) { const p=r.players.find(p=>p.id===player.id); p.connected=true; p.socketId=player.socketId; return p; }
 if(r.players.length>=r.maxPlayers) throw new Error('الغرفة مكتملة');
 r.players.push({...player,ready:false,connected:true,joinedAt:Date.now()}); return r.players[r.players.length-1];
}
function newRoom(user, settings={}) {
 let c=code(); while([...rooms.values()].some(r=>r.code===c)) c=code();
 const r={id:uid(),code:c,hostId:user.id,hostName:user.username,game:games[settings.game]?settings.game:'xo',status:'lobby',maxPlayers:Math.max(2,Math.min(10,Number(settings.maxPlayers)||8)),guestAccess:settings.guestAccess!==false,isPrivate:settings.isPrivate!==false,players:[],chat:[],state:null,createdAt:Date.now(),lastActive:Date.now()};
 rooms.set(r.id,r); addPlayer(r,{id:user.id,username:user.username,avatar:user.avatar||'🎮',socketId:null}); return r;
}
function finishMatch(r, winnerId, reason='completed') {
 if(!r || r.status!=='playing') return;
 r.status='finished'; r.state = {...(r.state||{}),finished:true,winnerId,finishReason:reason};
 const matchId=uid(); const participants=r.players.map(p=>p.id); const xpBase=games[r.game]?.xp||50;
 const scoreObj={}; for(const p of r.players) scoreObj[p.id]=p.id===winnerId?xpBase:10;
 const insertMatch=db.prepare('INSERT INTO matches(id,game,room_code,winner_id,participants_json,scores_json) VALUES(?,?,?,?,?,?)');
 const insertReward=db.prepare('INSERT OR IGNORE INTO reward_transactions(match_id,user_id,xp_delta,rating_delta) VALUES(?,?,?,?)');
 const update=db.prepare('UPDATE users SET xp=xp+?, rating=MAX(0,rating+?), wins=wins+?, losses=losses+?, played=played+1 WHERE id=?');
 const tx=db.transaction(()=>{
  insertMatch.run(matchId,r.game,r.code,winnerId||null,JSON.stringify(participants),JSON.stringify(scoreObj));
  for(const p of r.players){ const won=p.id===winnerId; const xp=scoreObj[p.id]; const rd=winnerId?(won?18:-12):0; insertReward.run(matchId,p.id,xp,rd); update.run(xp,rd,won?1:0,winnerId&&!won?1:0,p.id); }
 });
 try { tx(); } catch(e) { console.error('match persistence failed',e.message); }
 emitPersonalRoom(r); io.to(r.id).emit('match:finished',{winnerId,winnerName:r.players.find(p=>p.id===winnerId)?.username||null,reason,xp:xpBase});
}
function startGame(r) {
 if(r.status!=='lobby') throw new Error('المباراة بدأت بالفعل');
 if(r.players.length<2) throw new Error('تحتاج لاعبين اثنين على الأقل');
 if(r.game==='auction' && r.players.length<3) throw new Error('مزاد الأسئلة يحتاج 3 لاعبين على الأقل');
 if(r.game==='codenames' && r.players.length<4) throw new Error('كود نيمز تحتاج 4 لاعبين على الأقل');
 if(r.game==='xo' && r.players.length!==2) throw new Error('إكس أو تحتاج لاعبين اثنين فقط');
 r.status='playing';
 if(r.game==='xo') r.state={board:Array(9).fill(null),turn:r.players[0].id,symbols:{[r.players[0].id]:'X',[r.players[1].id]:'O'},moves:0};
 if(r.game==='auction') r.state={phase:'bidding',round:1,bids:[],turnIndex:0,questionIndex:0,currentPlayerId:null,currentQuestion:null,score:Object.fromEntries(r.players.map(p=>[p.id,0])),log:[]};
 if(r.game==='madgab') { r.state={round:1,maxRounds:5,turnIndex:0,score:Object.fromEntries(r.players.map(p=>[p.id,0])),current:phrases[Math.floor(Math.random()*phrases.length)],hintUsed:false,deadline:Date.now()+45000}; }
 if(r.game==='codenames') {
  const shuffled=[...words].sort(()=>Math.random()-.5).slice(0,25); const colors=Array(25).fill('neutral'); const firstRed=Math.random()<.5; const red=firstRed?9:8, blue=firstRed?8:9; const ids=Array.from({length:25},(_,i)=>i).sort(()=>Math.random()-.5); for(let i=0;i<red;i++) colors[ids[i]]='red'; for(let i=red;i<red+blue;i++) colors[ids[i]]='blue'; colors[ids[red+blue]]='assassin';
  const teams={}; r.players.forEach((p,i)=>teams[p.id]=i%2===0?'red':'blue'); const captains={red:r.players.find((p,i)=>i%2===0)?.id,blue:r.players.find((p,i)=>i%2===1)?.id};
  r.state={board:shuffled.map((word,i)=>({word,color:colors[i],revealed:false})),teams,captains,turn:'red',clue:null,guessesLeft:0,score:{red:0,blue:0},firstTeam:firstRed?'red':'blue'};
 }
 emitPersonalRoom(r);
}
function xoWinner(board) { const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]; for(const [a,b,c] of lines) if(board[a]&&board[a]===board[b]&&board[a]===board[c]) return board[a]; return null; }
function handleAction(r, userId, action) {
 r.lastActive=Date.now();
 if(r.status!=='playing') throw new Error('لا توجد مباراة جارية'); const s=r.state;
 if(r.game==='xo') {
  if(s.turn!==userId) throw new Error('ليس دورك'); const idx=Number(action.index); if(!Number.isInteger(idx)||idx<0||idx>8||s.board[idx]) throw new Error('حركة غير صالحة'); s.board[idx]=s.symbols[userId]; s.moves++; const w=xoWinner(s.board); if(w) { finishMatch(r,Object.keys(s.symbols).find(id=>s.symbols[id]===w)); return; } if(s.moves===9){finishMatch(r,null,'draw');return;} s.turn=Number(Object.keys(s.symbols).find(id=>Number(id)!==userId)); emitPersonalRoom(r); return;
 }
 if(r.game==='auction') {
  if(s.phase==='bidding') {
   if(s.turnIndex>=r.players.length) { if(!s.bids.length) { s.phase='answering'; s.currentPlayerId=r.players[0].id; s.currentQuestion=questions[Math.floor(Math.random()*questions.length)]; s.questionIndex=0; } else { const high=[...s.bids].sort((a,b)=>b.amount-a.amount)[0]; s.phase='answering'; s.currentPlayerId=high.userId; s.promised=high.amount; s.currentQuestion=questions[Math.floor(Math.random()*questions.length)]; s.questionIndex=0; } }
   else { if(r.players[s.turnIndex].id!==userId) throw new Error('انتظر دورك في المزايدة'); const amount=Math.max(0,Math.min(10,Number(action.amount))); if(!Number.isInteger(amount)) throw new Error('المزايدة غير صحيحة'); s.bids.push({userId,amount}); s.turnIndex++; if(s.turnIndex>=r.players.length){ const high=[...s.bids].sort((a,b)=>b.amount-a.amount)[0]; s.phase='answering'; s.currentPlayerId=high.userId; s.promised=Math.max(1,high.amount||1); s.currentQuestion=questions[Math.floor(Math.random()*questions.length)]; s.questionIndex=0; } }
  } else { if(s.currentPlayerId!==userId) throw new Error('الإجابة للاعب صاحب المزايدة'); const answer=String(action.answer||'').trim().toLocaleLowerCase('ar'); const correct=answer===s.currentQuestion.a.toLocaleLowerCase('ar'); s.log.push({username:r.players.find(p=>p.id===userId)?.username,question:s.currentQuestion.q,correct}); if(correct) s.score[userId]=(s.score[userId]||0)+1; s.questionIndex++; if(s.questionIndex >= (s.promised||3)) { const winner=Object.entries(s.score).sort((a,b)=>b[1]-a[1])[0]; finishMatch(r,Number(winner?.[0]),'auction-complete'); return; } s.currentQuestion=questions[Math.floor(Math.random()*questions.length)]; }
  emitPersonalRoom(r); return;
 }
 if(r.game==='madgab') {
  const guess=String(action.guess||'').trim().toLocaleLowerCase('ar'); if(guess.length>120) throw new Error('الإجابة طويلة جدًا');
  if(guess.replace(/[\s\u0640]/g,'')===s.current.answer.replace(/[\s\u0640]/g,'').toLocaleLowerCase('ar')) { s.score[userId]=(s.score[userId]||0)+1; s.round++; if(s.round>s.maxRounds){ const win=Object.entries(s.score).sort((a,b)=>b[1]-a[1])[0]; finishMatch(r,Number(win?.[0]),'madgab-complete'); return; } s.current=phrases[Math.floor(Math.random()*phrases.length)]; s.hintUsed=false; s.deadline=Date.now()+45000; }
  emitPersonalRoom(r); return;
 }
 if(r.game==='codenames') {
  const team=s.teams[userId]; if(!team) throw new Error('أنت لست ضمن الفريق'); const isCaptain=s.captains[team]===userId;
  if(action.type==='clue') { if(!isCaptain||team!==s.turn) throw new Error('قائد الفريق الحالي فقط يرسل التلميح'); const clue=String(action.clue||'').trim(); const count=Number(action.count); if(!clue||clue.length>60||!Number.isInteger(count)||count<1||count>9) throw new Error('التلميح أو العدد غير صحيح'); s.clue={text:clue,count}; s.guessesLeft=count; }
  else if(action.type==='reveal') { if(isCaptain||team!==s.turn||!s.clue||s.guessesLeft<1) throw new Error('لا يمكنك كشف هذه الكلمة الآن'); const idx=Number(action.index); if(!Number.isInteger(idx)||idx<0||idx>24||s.board[idx].revealed) throw new Error('اختيار غير صالح'); const card=s.board[idx]; card.revealed=true; if(card.color==='assassin'){finishMatch(r,null,'assassin');return;} if(card.color==='red'||card.color==='blue'){s.score[card.color]++; if(s.board.filter(c=>c.color===card.color&&c.revealed).length===(s.board.filter(c=>c.color===card.color).length)){finishMatch(r,Number(s.captains[card.color]),'codenames-complete');return;} }
   s.guessesLeft--; if(card.color!==team||s.guessesLeft===0){s.turn=team==='red'?'blue':'red';s.clue=null;s.guessesLeft=0;}
  } else if(action.type==='endTurn') { if(isCaptain||team!==s.turn) throw new Error('لا يمكنك إنهاء الدور'); s.turn=team==='red'?'blue':'red';s.clue=null;s.guessesLeft=0; }
  emitPersonalRoom(r); return;
 }
 throw new Error('اللعبة غير مدعومة');
}
app.get('/api/health',(_,res)=>res.json({ok:true,service:'sahra-party',time:new Date().toISOString()}));
app.post('/api/auth/register', async (req,res)=>{
 const username=String(req.body.username||'').trim(); const password=String(req.body.password||'');
 if(!/^[\p{L}\p{N}_]{3,18}$/u.test(username)) return res.status(400).json({error:'اسم المستخدم من 3 إلى 18 حرفًا أو رقمًا، ويسمح بـ _'});
 if(password.length<8||password.length>100) return res.status(400).json({error:'كلمة المرور يجب أن تكون 8 أحرف على الأقل'});
 try { const hash=await bcrypt.hash(password,12); const result=db.prepare('INSERT INTO users(username,password_hash) VALUES(?,?)').run(username,hash); const user=db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid); const token=tokenFor(user); res.cookie('session',token,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:14*86400000}); res.json({token,user:publicUser(user)}); }
 catch(e){res.status(409).json({error:e.code==='SQLITE_CONSTRAINT_UNIQUE'?'اسم المستخدم مستخدم بالفعل':'تعذر إنشاء الحساب'});}
});
app.post('/api/auth/login',async(req,res)=>{const username=String(req.body.username||'').trim();const password=String(req.body.password||'');const row=db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username);if(!row||!(await bcrypt.compare(password,row.password_hash)))return res.status(401).json({error:'اسم المستخدم أو كلمة المرور غير صحيحة'});const token=tokenFor(row);res.cookie('session',token,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:14*86400000});res.json({token,user:publicUser(row)});});
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('session');res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>{const row=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);if(!row)return res.status(404).json({error:'الحساب غير موجود'});res.json({user:publicUser(row)});});
app.get('/api/leaderboard',(req,res)=>{const rows=db.prepare('SELECT id,username,avatar,xp,rating,wins,losses,played FROM users ORDER BY rating DESC,xp DESC LIMIT 50').all();res.json({players:rows.map(publicUser)});});
app.get('/api/profile/:username',(req,res)=>{const u=db.prepare('SELECT id,username,avatar,xp,rating,wins,losses,played,created_at FROM users WHERE username=? COLLATE NOCASE').get(req.params.username);if(!u)return res.status(404).json({error:'اللاعب غير موجود'});const matches=db.prepare('SELECT id,game,winner_id,participants_json,finished_at FROM matches WHERE participants_json LIKE ? ORDER BY finished_at DESC LIMIT 20').all(`%${u.id}%`).map(m=>({...m,won:m.winner_id===u.id}));res.json({user:publicUser(u),matches});});
app.get('/api/matches',auth,(req,res)=>{const rows=db.prepare('SELECT m.* FROM matches m WHERE participants_json LIKE ? ORDER BY finished_at DESC LIMIT 30').all(`%${req.user.id}%`);res.json({matches:rows.map(m=>({...m,participants:JSON.parse(m.participants_json),scores:JSON.parse(m.scores_json)}))});});
app.get('/api/games',(_,res)=>res.json({games:Object.entries(games).map(([id,g])=>({id,...g}))}));

io.use((socket,next)=>{try{const token=(socket.handshake.auth||{}).token; if(!token) return next(new Error('سجّل الدخول أولًا'));socket.user=jwt.verify(token,JWT_SECRET);next();}catch{next(new Error('الجلسة غير صالحة'));}});
io.on('connection',socket=>{
 const userId=Number(socket.user.id); if(!socketsByUser.has(userId))socketsByUser.set(userId,new Set());socketsByUser.get(userId).add(socket.id);
 socket.on('room:create',(settings,cb)=>{try{const row=db.prepare('SELECT * FROM users WHERE id=?').get(userId);if(!row)throw new Error('الحساب غير موجود');const r=newRoom(publicUser(row),settings||{});r.players[0].socketId=socket.id;socket.join(r.id);r.lastActive=Date.now();cb?.({ok:true,room:safeRoom(r,userId),invite:`${process.env.PUBLIC_URL||''}/room/${r.id}`});emitPersonalRoom(r);}catch(e){cb?.({ok:false,error:e.message});}});
 socket.on('room:join',(idOrCode,cb)=>{try{const r=findRoom(idOrCode);if(!r)throw new Error('الغرفة غير موجودة أو انتهت صلاحيتها');if(r.status==='finished')throw new Error('انتهت هذه المباراة');const row=db.prepare('SELECT * FROM users WHERE id=?').get(userId);if(!row)throw new Error('الحساب غير موجود');addPlayer(r,{id:userId,username:row.username,avatar:row.avatar,socketId:socket.id});socket.join(r.id);r.lastActive=Date.now();cb?.({ok:true,room:safeRoom(r,userId)});emitPersonalRoom(r);}catch(e){cb?.({ok:false,error:e.message});}});
 socket.on('room:ready',(ready,cb)=>{const r=[...rooms.values()].find(x=>x.players.some(p=>p.id===userId));if(!r)return cb?.({ok:false,error:'لست في غرفة'});const p=r.players.find(p=>p.id===userId);p.ready=!!ready;emitPersonalRoom(r);cb?.({ok:true});});
 socket.on('room:settings',(settings,cb)=>{try{const r=[...rooms.values()].find(x=>x.players.some(p=>p.id===userId));if(!r)throw new Error('لست في غرفة');if(r.hostId!==userId)throw new Error('المضيف فقط يستطيع تغيير الإعدادات');if(r.status!=='lobby')throw new Error('لا يمكن تغيير الإعدادات بعد بدء المباراة');if(games[settings.game])r.game=settings.game;if(settings.maxPlayers)r.maxPlayers=Math.max(2,Math.min(10,Number(settings.maxPlayers)));if(r.maxPlayers<r.players.length)throw new Error('السعة أقل من عدد اللاعبين الحالي');emitPersonalRoom(r);cb?.({ok:true});}catch(e){cb?.({ok:false,error:e.message});}});
 socket.on('room:start',(_,cb)=>{try{const r=[...rooms.values()].find(x=>x.players.some(p=>p.id===userId));if(!r)throw new Error('لست في غرفة');if(r.hostId!==userId)throw new Error('المضيف فقط يستطيع بدء المباراة');startGame(r);cb?.({ok:true});}catch(e){cb?.({ok:false,error:e.message});}});
 socket.on('game:action',(action,cb)=>{try{const r=[...rooms.values()].find(x=>x.players.some(p=>p.id===userId));if(!r)throw new Error('لست في غرفة');handleAction(r,userId,action||{});cb?.({ok:true});}catch(e){cb?.({ok:false,error:e.message});}});
 socket.on('room:chat',(message,cb)=>{const r=[...rooms.values()].find(x=>x.players.some(p=>p.id===userId));if(r)r.lastActive=Date.now();const text=String(message||'').trim();if(!r||!text||text.length>300)return cb?.({ok:false,error:'رسالة غير صالحة'});r.chat.push({userId,username:r.players.find(p=>p.id===userId)?.username||'لاعب',text:text.replace(/[<>]/g,''),at:Date.now()});r.chat=r.chat.slice(-100);emitPersonalRoom(r);cb?.({ok:true});});
 socket.on('room:leave',(_,cb)=>{const r=[...rooms.values()].find(x=>x.players.some(p=>p.id===userId));if(!r)return cb?.({ok:true});const p=r.players.find(p=>p.id===userId);r.players=r.players.filter(p=>p.id!==userId);socket.leave(r.id);if(!r.players.length){rooms.delete(r.id);}else{if(r.hostId===userId){r.hostId=r.players[0].id;r.hostName=r.players[0].username;}if(r.status==='playing'&&r.game==='xo')finishMatch(r,r.players[0].id,'opponent-left');else emitPersonalRoom(r);}cb?.({ok:true});});
 socket.on('disconnect',()=>{const set=socketsByUser.get(userId);if(set){set.delete(socket.id);if(!set.size)socketsByUser.delete(userId);}for(const r of rooms.values()){const p=r.players.find(p=>p.id===userId&&p.socketId===socket.id);if(p){p.connected=false;if(r.hostId===userId){const next=r.players.find(x=>x.connected&&x.id!==userId);if(next){r.hostId=next.id;r.hostName=next.username;}}emitPersonalRoom(r);}}});
});
setInterval(()=>{const now=Date.now();for(const [id,r] of rooms){if(now-r.lastActive>6*60*60*1000||(!r.players.length)){rooms.delete(id);}}},10*60*1000).unref();
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
server.listen(PORT,()=>console.log(`Sahra Party running on port ${PORT}`));
