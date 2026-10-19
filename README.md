# AgriDrone Analytics — backend

Zero-dependency Node server (Node 18+). App (`public/index.html`) aur API ek hi server se chalte hain.

## Chalana

```bash
cd agridrone-backend
OWNER_PIN=1234 node server.js      # http://localhost:3000
```

- `OWNER_PIN` (4 digit) pehla owner PIN set karta hai. Na do to **pehla owner login** PIN set kar dega — public server par hamesha `OWNER_PIN` do.
- Doosre env: `PORT`, `DATA_DIR` (default `./data`, yahin `db.json` banti hai — hosting par isay persistent disk par rakho), `CORS_ORIGIN`, `TRUST_PROXY=1` (Render/Railway/nginx ke peeche).
- Test: `npm test`

## Kaise kaam karta hai

- Farmer app mein register karta hai → server par account banta hai (token phone mein). Reports, spray/seeding jobs, accounts har change par sync hote hain; offline ho to baad mein khud sync hote hain.
- Owner dashboard server se **sab phones ke users** dikhata hai (har 20 sec refresh).
- Owner ▸ **Settings**: server address + test, owner ka naam, default language, health index ki limits (Good/Fair), PIN change, CSV/JSON export, saara data delete.
- App ko file ki tarah (file://) ya APK mein kholo to Settings mein server ka URL daalo (e.g. `https://myapp.onrender.com`).

## API (short)

| | |
|---|---|
| `GET /api/health`, `GET /api/config` | public |
| `POST /api/users`, `PUT /api/users/:id`, `PUT/GET /api/users/:id/data` | farmer token (Bearer) |
| `POST /api/owner/login` | `{pin}` → owner token (5 galat PIN = 5 min lock) |
| `GET /api/owner/summary`, `/export`, `GET/PUT /api/owner/settings`, `POST /api/owner/pin`, `DELETE /api/owner/users/:id`, `POST /api/owner/wipe` | owner token |

Owner PIN scrypt se hashed store hota hai; farmer tokens sirf hash ho kar save hote hain.

## Naye features
- **Profile photo:** registration / Edit profile mein "Add photo". Photo 160x160 mein chhoti ho kar server par jaati hai aur owner ko users list, farm map popup mein nazar aati hai.
- **Video:** Analyze Crop > Capture screen par "Record Video" / "Upload Video". App video ke 6 frames check karti hai aur sab se zyada mutasir frame ka result dikhati hai.
- **Profile owner tak:** farmer ka naam, phone, shehar, acres, fasal aur photo server ke zariye owner dashboard (Users) mein aate hain.

## Doosron ke saath share karna (backend chalta rahe)
Claude ka published link (claude.ai/artifact/...) is backend se **nahi** judta. Doosron ko hamesha **server ka apna URL** do, jo ye folder chalane se banta hai. Teen tareeqe:

1. **Laptop par + same Wi-Fi/hotspot (competition ke liye sab se aasan):**
   `OWNER_PIN=1234 node server.js`, phir doosre phone par `http://<laptop-ka-IP>:3000`. IP: Windows `ipconfig`, Mac/Linux `ifconfig`. Is mein HTTP hai, is liye live camera popup nahi chalta, "Open camera app" / gallery chalta hai.
2. **Laptop par + public HTTPS link:** server chalate hue ek tunnel tool (cloudflared ya ngrok) se `http://localhost:3000` ko public https URL do. Camera popup bhi chalega. Laptop band to link band.
3. **Hosting (hamesha online):** is folder ko GitHub par rakho, Render / Railway jaisi service par Node web service banao. Start command `node server.js`. Env: `OWNER_PIN`, `TRUST_PROXY=1`, `DATA_DIR` (persistent disk ka path). **Free plan par data restart/redeploy par ud jata hai** (disk nahi hoti) aur service 15 minute baad so jati hai. Data bachane ke liye persistent disk wala paid plan lo.

Owner PIN hamesha khud do (`OWNER_PIN`), warna jo pehle login kare wahi PIN bana dega.
