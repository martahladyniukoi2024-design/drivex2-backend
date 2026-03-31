// ════════════════════════════════════════════════════════════
//  DriveNow (drivex2) — Серверна частина  |  Варіант 6
//  Лабораторна робота №5
// ════════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');

// ── Firebase Admin SDK ───────────────────────────────────────
let useFirebase = false;
let db = null;

try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  useFirebase = true;
  console.log('✅ Firebase Firestore підключено');
} catch (e) {
  console.log('⚠️  serviceAccountKey.json не знайдено — використовується in-memory сховище');
}

// ── In-memory fallback ────────────────────────────────────────
let memBookings = [];

// ════════════════════════════════════════════════════════════
//  Express
// ════════════════════════════════════════════════════════════
const app  = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://starlit-bublanina-43e9d1.netlify.app',
  ],
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// ════════════════════════════════════════════════════════════
//  ЗАВДАННЯ 3 — GET /api/bookings?userId=xxx
//  Отримати всі бронювання користувача (сортовані, новіші перші)
// ════════════════════════════════════════════════════════════
app.get('/api/bookings', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ success: false, message: 'userId є обовязковим параметром' });
  }

  try {
    let bookings;

    if (useFirebase) {
      const snap = await db.collection('bookings')
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .get();
      bookings = snap.docs.map(d => ({
        id: d.id,
        ...d.data(),
        // Конвертуємо Firestore Timestamp → ISO рядок для фронтенду
        createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null,
      }));
    } else {
      bookings = memBookings
        .filter(b => b.userId === userId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    res.json({ success: true, data: bookings });
  } catch (err) {
    console.error('GET /api/bookings error:', err);
    res.status(500).json({ success: false, message: 'Помилка сервера: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  ЗАВДАННЯ 4 — POST /api/bookings
//  Зберегти нове бронювання з перевіркою доступності авто
// ════════════════════════════════════════════════════════════
app.post('/api/bookings', async (req, res) => {
  const { userId, carId, carName, carImage, carPrice, startDate, endDate } = req.body;

  // ── Валідація ────────────────────────────────────────────
  if (!userId || !carId || !carName || !carPrice || !startDate || !endDate) {
    return res.status(400).json({ success: false, message: 'Усі поля є обовязковими' });
  }

  if (new Date(endDate) <= new Date(startDate)) {
    return res.status(400).json({ success: false, message: 'Дата повернення має бути після дати початку' });
  }

  // ── Перевірка доступності авто на вибрані дати ───────────
  try {
    let isBooked = false;

    if (useFirebase) {
      const snap = await db.collection('bookings')
        .where('carId', '==', carId)
        .where('status', '==', 'active')
        .get();

      // Перевіряємо перетин дат
      isBooked = snap.docs.some(d => {
        const b = d.data();
        return b.startDate <= endDate && b.endDate >= startDate;
      });
    } else {
      isBooked = memBookings.some(b =>
        b.carId === carId &&
        b.status === 'active' &&
        b.startDate <= endDate &&
        b.endDate >= startDate
      );
    }

    if (isBooked) {
      return res.status(409).json({
        success: false,
        message: `Автомобіль "${carName}" вже заброньований на ці дати. Оберіть інший період.`,
      });
    }

    // ── Збереження бронювання ────────────────────────────────
    const newBooking = {
      userId,
      carId,
      carName,
      carImage: carImage || '',
      carPrice: Number(carPrice),
      startDate,
      endDate,
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    if (useFirebase) {
      const docRef = await db.collection('bookings').add({
        ...newBooking,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Автоматично зменшуємо кількість доступних (позначаємо авто як зайняте)
      try {
        await db.collection('cars').doc(carId).update({ available: false });
      } catch (e) {
        console.warn('Could not update car availability:', e.message);
      }

      newBooking.id = docRef.id;
    } else {
      newBooking.id = 'b' + Date.now();
      memBookings.push(newBooking);
    }

    res.status(201).json({
      success: true,
      message: `Автомобіль "${carName}" успішно заброньовано!`,
      data: newBooking,
    });

  } catch (err) {
    console.error('POST /api/bookings error:', err);
    res.status(500).json({ success: false, message: 'Помилка сервера: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  PATCH /api/bookings/:id — скасувати бронювання
// ════════════════════════════════════════════════════════════
app.patch('/api/bookings/:id', async (req, res) => {
  const { id } = req.params;
  const { status, carId } = req.body;

  if (!['active', 'cancelled'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Недопустимий статус' });
  }

  try {
    if (useFirebase) {
      await db.collection('bookings').doc(id).update({ status });

      // При скасуванні — повертаємо авто в доступні
      if (status === 'cancelled' && carId) {
        try {
          await db.collection('cars').doc(carId).update({ available: true });
        } catch (e) {
          console.warn('Could not restore car availability:', e.message);
        }
      }
    } else {
      const b = memBookings.find(b => b.id === id);
      if (!b) return res.status(404).json({ success: false, message: 'Бронювання не знайдено' });
      b.status = status;
    }

    res.json({ success: true, message: `Статус оновлено: ${status}` });
  } catch (err) {
    console.error('PATCH /api/bookings error:', err);
    res.status(500).json({ success: false, message: 'Помилка сервера: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  GET /api/availability — зайняті carId на вказані дати
// ════════════════════════════════════════════════════════════
app.get('/api/availability', async (req, res) => {
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    return res.status(400).json({ success: false, message: 'startDate і endDate є обовязковими' });
  }

  try {
    let bookedIds = [];

    if (useFirebase) {
      const snap = await db.collection('bookings')
        .where('status', '==', 'active')
        .get();

      bookedIds = snap.docs
        .filter(d => {
          const b = d.data();
          return b.startDate <= endDate && b.endDate >= startDate;
        })
        .map(d => d.data().carId);
    } else {
      bookedIds = memBookings
        .filter(b =>
          b.status === 'active' &&
          b.startDate <= endDate &&
          b.endDate >= startDate
        )
        .map(b => b.carId);
    }

    res.json({ success: true, bookedIds: [...new Set(bookedIds)] });
  } catch (err) {
    console.error('GET /api/availability error:', err);
    res.status(500).json({ success: false, message: 'Помилка сервера: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  Запуск
// ════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`🚗 DriveNow сервер запущено: http://localhost:${PORT}`);
  console.log(`📦 Режим: ${useFirebase ? 'Firebase Firestore' : 'In-memory (локально)'}`);
});
