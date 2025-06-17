const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");
const { Buffer } = require("buffer");
const { onSchedule } = require("firebase-functions/v2/scheduler");



admin.initializeApp();


exports.activateHive = functions.https.onRequest(async (req, res) => {
  try {
    // Sadece POST isteklerine izin ver
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const { userId, hiveId } = req.body;

    if (!userId || !hiveId) {
      return res.status(400).send("Missing required fields: userId, hiveId");
    }

    const db = admin.firestore();
    const hiveRef = db
      .collection("Users")
      .doc(userId)
      .collection("Hives")
      .doc(hiveId);

    // Kovan dokümanını güncelle
    await hiveRef.update({
      isActive: true,
      lastActivation: admin.firestore.Timestamp.now()
    });

    return res.status(200).json({
      message: "Hive activated successfully",
      hiveId: hiveId,
      isActive: true,
      lastActivation: admin.firestore.Timestamp.now()
    });

  } catch (err) {
    console.error("Error:", err);
    
    // Eğer kovan bulunamazsa özel bir hata mesajı döndür
    if (err.code === 5) { // NOT_FOUND error code
      return res.status(404).send("Hive not found");
    }
    
    return res.status(500).send("Internal Server Error");
  }
});

exports.saveImage = functions.https.onRequest(async (req, res) => {
  try {
    const { userId, hiveId, imageData } = req.body;

    if (!userId || !hiveId || !imageData) {
      return res.status(400).send("Missing required fields.");
    }

    // 1. Görseli Storage'a yükle
    const buffer = Buffer.from(imageData, 'base64');
    const timestamp = Date.now();
    const fileName = `${timestamp}.jpg`;
    const storagePath = `images/${userId}/${hiveId}/${fileName}`;

    const bucket = admin.storage().bucket();
    const file = bucket.file(storagePath);

    const token = uuidv4();
    await file.save(buffer, {
      metadata: {
        contentType: 'image/jpeg',
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
      public: true,
      resumable: false,
    });

    const imageUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;

    // 2. Firestore'a görseli kaydet
    const imageDocRef = admin.firestore()
      .collection("Users")
      .doc(userId)
      .collection("Hives")
      .doc(hiveId)
      .collection("Images")
      .doc();

    await imageDocRef.set({
      imageUrl,
      storagePath,
      timestamp: admin.firestore.Timestamp.now()
    });

    // 3. Hive dokümanını güncelle
    const hiveDocRef = admin.firestore()
      .collection("Users")
      .doc(userId)
      .collection("Hives")
      .doc(hiveId);

    // Transaction kullanarak atomik işlem
    await admin.firestore().runTransaction(async (transaction) => {
      const hiveDoc = await transaction.get(hiveDocRef);
      const currentCount = (hiveDoc.data()?.detectionCount || 0) + 1;
      
      // Risk seviyesini belirle
      let riskLevel = "low";
      if (currentCount >= 100) riskLevel = "high";
      else if (currentCount >= 10) riskLevel = "medium";

      // Güncelleme işlemleri
      transaction.update(hiveDocRef, {
        detectionCount: currentCount,
        riskLevel: riskLevel,
        lastDetection: admin.firestore.Timestamp.now()
      });

      return { currentCount, riskLevel }; // Sonraki adımda kullanmak için
    });
    // 4. Kullanıcıyı bilgilendir (tıklanmayan bildirim)
    const userDoc = await admin.firestore()
      .collection("Users")
      .doc(userId)
      .get();

    const fcmToken = userDoc.data()?.fcmToken;
    const hiveName = (await hiveDocRef.get()).data()?.name || hiveId;

    

    /*
    if (fcmToken) {
      const currentCount = (await hiveDocRef.get()).data()?.detectionCount || 1;
      
      // Sadece data payload kullanarak bildirim gönder (notification olmadan)
      if ([1, 10, 100].includes(currentCount)) {
        const message = {
          token: fcmToken,
          data: { // Sadece data payload
            title: "Kovan Aktivitesi",
            message: `${hiveName} kovanında ${currentCount} hareket tespit edildi`,
            riskLevel: (await hiveDocRef.get()).data()?.riskLevel || "low",
            hiveId: hiveId,
            type: "risk_alert",
            priority: "high" // Arka planda bile gösterilsin
          },
          android: {
            priority: "high" // Android öncelik
          },
          apns: {
            headers: {
              "apns-priority": "10" // iOS öncelik
            }
          }
        };

        await admin.messaging().send(message);
        console.log(`📲 Tıklanmayan bildirim gönderildi: ${userId}/${hiveId}`);
      }
    }
      */

    return res.status(200).send("Image uploaded and silent notification sent.");
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).send("Internal Server Error");
  }
});

exports.getUserHives = functions.https.onRequest(async (req, res) => {
  try {
    // Sadece GET isteklerine izin ver
    if (req.method !== "GET") {
      return res.status(405).send("Method Not Allowed");
    }

    const userId = req.query.userId;

    if (!userId) {
      return res.status(400).send("userId query parameter is required.");
    }

    // Kullanıcının kovanlarını Firestore'dan al
    const hivesSnapshot = await admin
      .firestore()
      .collection("Users")
      .doc(userId)
      .collection("Hives")
      .get();

    // Kovan verilerini işle
    const hives = [];
    hivesSnapshot.forEach((doc) => {
      const hiveData = doc.data();
      hives.push({
        hiveId: doc.id, // Doküman ID'sini ekliyoruz
        detectionCount: hiveData.detectionCount || 0,
        isActive: hiveData.isActive || false,
        location: hiveData.location || "",
        lastActivation: hiveData.lastActivation.toDate.toLocaleString("tr-TR", {
  timeZone: "Europe/Istanbul"
}),
        hiveName: hiveData.name || doc.id,
        riskLevel: hiveData.riskLevel
      });
    });

    return res.status(200).json(hives);
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).send("Internal Server Error");
  }
});

exports.getHiveImages = functions.https.onRequest(async (req, res) => {
  try {
    // Sadece GET isteklerine izin ver
    if (req.method !== "GET") {
      return res.status(405).send("Method Not Allowed");
    }

    const { userId, hiveId } = req.query;

    if (!userId || !hiveId) {
      return res.status(400).send("userId and hiveId query parameters are required.");
    }

    // Firestore'dan görselleri al
    const imagesSnapshot = await admin
      .firestore()
      .collection("Users")
      .doc(userId)
      .collection("Hives")
      .doc(hiveId)
      .collection("Images")
      .orderBy("timestamp", "desc") // Tarihe göre sırala
      .get();

    const images = [];
    imagesSnapshot.forEach((doc) => {
      const imageData = doc.data();
      images.push({
        imageId: doc.id,
        timestamp: imageData.timestamp.toDate().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) ,
        imageUrl: imageData.imageUrl
      });
    });

    return res.status(200).json(images);
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).send("Internal Server Error");
  }
});

exports.reportFalseDetection = functions.https.onRequest(async (req, res) => {
  try {
    // Sadece POST isteklerine izin ver
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const { userId, hiveId, imageId } = req.body;

    if (!userId || !hiveId || !imageId) {
      return res.status(400).send("Missing required fields: userId, hiveId, imageId");
    }

    const db = admin.firestore();
    const bucket = admin.storage().bucket();

    // 1. Image dokümanını al
    const imageDocRef = db
      .collection("Users")
      .doc(userId)
      .collection("Hives")
      .doc(hiveId)
      .collection("Images")
      .doc(imageId);

    const imageDoc = await imageDocRef.get();
    if (!imageDoc.exists) {
      return res.status(404).send("Image not found");
    }

    const imageData = imageDoc.data();
    const oldStoragePath = imageData.storagePath;

    // 2. Hive'daki detectionCount'u azalt
    const hiveDocRef = db
      .collection("Users")
      .doc(userId)
      .collection("Hives")
      .doc(hiveId);

    await hiveDocRef.update({
      detectionCount: admin.firestore.FieldValue.increment(-1)
    });

    // 3. Storage'da dosyayı taşı (copy + delete)
    const newFileName = `${imageId}_${Date.now()}.jpg`;
    const newStoragePath = `reports/${userId}/${hiveId}/${newFileName}`;
    const sourceFile = bucket.file(oldStoragePath);
    const destinationFile = bucket.file(newStoragePath);

    // Dosyayı kopyala
    await sourceFile.copy(destinationFile);

    // Yeni dosyayı public yap
    await destinationFile.makePublic();

    // Yeni public URL oluştur
    const imageUrl = `https://storage.googleapis.com/${bucket.name}/${encodeURIComponent(newStoragePath)}`;

    // Orijinali sil
    await sourceFile.delete();

    // 4. Reports koleksiyonuna ekle
    const reportData = {
      originalTimestamp: imageData.timestamp,
      reportedAt: admin.firestore.Timestamp.now(),
      userId,
      hiveId,
      imageId,
      storagePath: newStoragePath,
      imageUrl: imageUrl,
      status: "reported"
    };

    await db.collection("Reports").add(reportData);

    // 5. Orijinal image dokümanını sil
    await imageDocRef.delete();

    return res.status(200).json({
      message: "False detection reported successfully",
      reportImageUrl: imageUrl
    });

  } catch (err) {
    console.error("Error:", err);
    return res.status(500).send("Internal Server Error");
  }
});



exports.deactivateInactiveHives = onSchedule(
  {
    schedule: "every 20 minutes",
    timeZone: "Europe/Istanbul",
  },
  async (event) => {
    console.log("🔍 Kovan aktivite kontrolü başladı...");

    try {
      const db = admin.firestore();
      const now = new Date();
      const cutoffTime = new Date(now.getTime() - 20 * 60 * 1000);

      const usersSnapshot = await db.collection("Users").get();

      const promises = usersSnapshot.docs.map(async (userDoc) => {
        const userId = userDoc.id;
        const userFcmToken = userDoc.data().fcmToken;
        const hivesRef = db.collection("Users").doc(userId).collection("Hives");

        const inactiveHivesSnapshot = await hivesRef
          .where("isActive", "==", true)
          .where("lastActivation", "<", cutoffTime)
          .get();

        const hiveUpdates = inactiveHivesSnapshot.docs.map(async (hiveDoc) => {
          const hiveId = hiveDoc.id;
          const hiveName = hiveDoc.data().name || hiveId;

          await hiveDoc.ref.update({ isActive: false });

          if (userFcmToken) {
            const notification = {
              title: "A hive is not active",
              body: `${hiveName} is not active for at least 20 minutes.`,
              android: {
                priority: "high"
              },
              apns: {
                headers: {
                  "apns-priority": "10"
                }
              }
            };

            /*
            await admin.messaging().sendToDevice(userFcmToken, {
              notification: notification,
              data: {
                hiveId: hiveId,
                type: "hive_deactivated"
              }
            });
            */

            console.log(`📲 Bildirim gönderildi: ${userId}/${hiveId}`);
          }

          console.log(`❌ Pasifleştirilen kovan: ${userId}/${hiveId}`);
        });

        return Promise.all(hiveUpdates);
      });

      await Promise.all(promises);
      console.log(`✅ ${usersSnapshot.size} kullanıcı kontrol edildi.`);
      return null;
    } catch (error) {
      console.error("⛔ Kritik Hata:", error);
      return null;
    }
  }
);


exports.loginUser = functions.https.onRequest(async (req, res) => {
  // 1. Sadece POST isteğine izin ver
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 2. Body'den verileri al
  const { email, password, fcmToken } = req.body;
  if (!email || !password || !fcmToken) {
    return res.status(400).json({ error: "Email, password ve FCM token gereklidir" });
  }

  try {
    // 3. Firestore'da email eşleşmesini ara
    const usersRef = admin.firestore().collection("Users");
    const querySnapshot = await usersRef
      .where("email", "==", email)
      .where("password", "==", password) // Düz metin karşılaştırma
      .limit(1)
      .get();

    // 4. Eşleşme kontrolü
    if (querySnapshot.empty) {
      return res.status(401).json({ error: "Geçersiz email veya şifre" });
    }

    // 5. Kullanıcı dokümanını al
    const userDoc = querySnapshot.docs[0];
    const userId = userDoc.id; // Firestore doküman ID'si

    // 6. FCM token'ı güncelle
    await userDoc.ref.update({
      fcmToken: fcmToken,
      lastLogin: admin.firestore.Timestamp.now()
    });

    // 7. Başarılı yanıt (userId dahil)
    return res.status(200).json({
      success: true,
      userId: userId, // Firestore doküman ID'si
      email: email
    });

  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

exports.clearHiveImages = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const { userId, hiveId } = req.body;

  if (!userId || !hiveId) {
    return res.status(400).send("Missing required fields: userId, hiveId");
  }

  const db = admin.firestore();
  const bucket = admin.storage().bucket();

  const imagesRef = db
    .collection("Users")
    .doc(userId)
    .collection("Hives")
    .doc(hiveId)
    .collection("Images");

  const hiveRef = db
    .collection("Users")
    .doc(userId)
    .collection("Hives")
    .doc(hiveId);

  try {
    const imagesSnapshot = await imagesRef.get();

    const deletePromises = imagesSnapshot.docs.map(async (doc) => {
      const data = doc.data();
      const storagePath = data.storagePath;

      if (storagePath) {
        const file = bucket.file(storagePath);
        try {
          await file.delete();
          console.log(`🗑️ Storage file deleted: ${storagePath}`);
        } catch (err) {
          console.warn(`⚠️ Error deleting storage file: ${storagePath}`, err.message);
        }
      }

      await doc.ref.delete();
      console.log(`🔥 Firestore image doc deleted: ${doc.id}`);
    });

    await Promise.all(deletePromises);

    // Hive dokümanını güncelle: detectionCount = 0, riskLevel = "no_risk", lastDetection = null
    await hiveRef.update({
      detectionCount: 0,
      riskLevel: "no_risk",
      lastDetection: null
    });

    return res.status(200).send("All images deleted and hive reset successfully.");
  } catch (error) {
    console.error("Error clearing hive images:", error);
    return res.status(500).send("Internal Server Error");
  }
});
