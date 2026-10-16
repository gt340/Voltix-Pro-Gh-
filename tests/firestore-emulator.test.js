const fs = require("node:fs");
const path = require("node:path");
const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} = require("firebase/firestore");

const projectId = "demo-voltix-rules";
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf8"),
    },
  });
});

after(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "admins/admin-1"), { role: "admin" });
    await setDoc(doc(db, "users/alice"), { balls: 10, sinkCoins: 8, sinkPts: 0, displayName: "Alice" });
    await setDoc(doc(db, "users/bob"), { balls: 5, sinkCoins: 4, sinkPts: 0, displayName: "Bob" });
    await setDoc(doc(db, "wallets/233555000001"), { balance: 999 });
    await setDoc(doc(db, "orders/order-1"), { customerUid: "alice", status: "pending" });
    await setDoc(doc(db, "matches/match-1"), {
      hostId: "alice",
      guestId: null,
      status: "waiting",
      hostScore: 0,
      guestScore: 0,
      hostDrops: 0,
      guestDrops: 0,
    });
    await setDoc(doc(db, "products/product-1"), { name: "Test product" });
    await setDoc(doc(db, "reviews/review-1"), { approved: true, featured: false, text: "Approved" });
  });
});

const userDb = (uid) => env.authenticatedContext(uid).firestore();
const adminDb = () => env.authenticatedContext("admin-1").firestore();
const anonDb = () => env.unauthenticatedContext().firestore();

test("private user documents are readable only by owner or admin", async () => {
  await assertSucceeds(getDoc(doc(userDb("alice"), "users/alice")));
  await assertFails(getDoc(doc(userDb("bob"), "users/alice")));
  await assertSucceeds(getDoc(doc(adminDb(), "users/alice")));
});

test("users cannot mint protected balances or change sinkPts; allowed balance decrements work", async () => {
  const alice = userDb("alice");
  await assertFails(updateDoc(doc(alice, "users/alice"), { balls: 11 }));
  await assertFails(updateDoc(doc(alice, "users/alice"), { sinkCoins: 9 }));
  await assertFails(updateDoc(doc(alice, "users/alice"), { sinkPts: 1 }));
  await assertSucceeds(updateDoc(doc(alice, "users/alice"), { balls: 9 }));
  await assertSucceeds(updateDoc(doc(alice, "users/alice"), { sinkCoins: 7 }));
  await assertFails(setDoc(doc(alice, "users/alice"), { balls: 10, sinkCoins: 8, sinkPts: 0 }));
  await assertFails(setDoc(doc(userDb("bob"), "users/charlie"), { balls: 0, sinkCoins: 0, sinkPts: 0 }));
});

test("wallets are inaccessible and admin-only catalog writes are enforced", async () => {
  await assertFails(getDoc(doc(userDb("alice"), "wallets/233555000001")));
  await assertFails(setDoc(doc(userDb("alice"), "products/new"), { name: "Injected" }));
  await assertSucceeds(setDoc(doc(adminDb(), "products/new"), { name: "Admin product" }));
  await assertFails(setDoc(doc(userDb("alice"), "coinPurchases/fake"), { amount: 999 }));
});

test("orders remain creatable by guests but private reads and mutations are admin-only", async () => {
  await assertSucceeds(setDoc(doc(anonDb(), "orders/guest-order"), { status: "pending" }));
  await assertFails(getDoc(doc(userDb("alice"), "orders/order-1")));
  await assertFails(updateDoc(doc(userDb("alice"), "orders/order-1"), { status: "paid" }));
  await assertSucceeds(getDoc(doc(adminDb(), "orders/order-1")));
});

test("reviews enforce approved-read visibility and prevent client moderation", async () => {
  await assertSucceeds(getDoc(doc(anonDb(), "reviews/review-1")));
  await assertFails(setDoc(doc(anonDb(), "reviews/unapproved"), { approved: true, featured: false, text: "Self-approved" }));
  await assertSucceeds(setDoc(doc(anonDb(), "reviews/pending"), { approved: false, featured: false, text: "Pending" }));
  await assertFails(updateDoc(doc(userDb("alice"), "reviews/review-1"), { approved: false }));
});

test("withdrawals require a signed-in user and valid pending request", async () => {
  await assertFails(setDoc(doc(anonDb(), "withdrawalRequests/w1"), { status: "pending", amount: 10 }));
  await assertFails(setDoc(doc(userDb("alice"), "withdrawalRequests/w2"), { status: "approved", amount: 10 }));
  await assertFails(setDoc(doc(userDb("alice"), "withdrawalRequests/w3"), { status: "pending", amount: -1 }));
  await assertSucceeds(setDoc(doc(userDb("alice"), "withdrawalRequests/w4"), { status: "pending", amount: 10 }));
  await assertFails(getDoc(doc(userDb("alice"), "withdrawalRequests/w4")));
});

test("match creation and joining are host/guest bound; signaling is participant-only", async () => {
  const alice = userDb("alice");
  const bob = userDb("bob");
  await assertSucceeds(setDoc(doc(alice, "matches/new-match"), {
    hostId: "alice", guestId: null, status: "waiting", hostScore: 0, guestScore: 0,
    hostDrops: 0, guestDrops: 0,
  }));
  await assertFails(setDoc(doc(bob, "matches/bad-match"), {
    hostId: "alice", guestId: null, status: "waiting",
  }));
  await assertSucceeds(updateDoc(doc(bob, "matches/match-1"), {
    guestId: "bob", guestName: "Bob", status: "playing",
  }));
  await assertSucceeds(setDoc(doc(bob, "matches/match-1/signal/s1"), { offer: "test" }));
  await assertFails(setDoc(doc(userDb("mallory"), "matches/match-1/signal/s2"), { offer: "test" }));
  await assertFails(deleteDoc(doc(bob, "matches/match-1")));
});

test("public leaderboard reads are allowed but another player's leaderboard cannot be written", async () => {
  await assertSucceeds(getDocs(collection(anonDb(), "leaderboard")));
  await assertSucceeds(setDoc(doc(userDb("alice"), "leaderboard/alice"), { score: 12 }));
  await assertFails(setDoc(doc(userDb("alice"), "leaderboard/bob"), { score: 999999 }));
});
