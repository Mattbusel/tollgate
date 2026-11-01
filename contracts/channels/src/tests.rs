use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = NEAR / 1000;
const SEC: u64 = 1_000_000_000;
const T0: u64 = 1_700_000_000 * SEC;

fn contract_id() -> AccountId {
    "channels.tollgate.testnet".parse().unwrap()
}
fn agent() -> AccountId {
    "agent.testnet".parse().unwrap()
}
fn seller() -> AccountId {
    "seller.testnet".parse().unwrap()
}
fn stranger() -> AccountId {
    "mallory.testnet".parse().unwrap()
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn pubkey(k: &SigningKey) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, k.verifying_key().to_bytes().to_vec()).unwrap()
}

fn sign(k: &SigningKey, channel: u64, cumulative: u128, nonce: u64) -> Base64VecU8 {
    let msg = build_voucher_message(contract_id().as_str(), channel, cumulative, nonce);
    Base64VecU8(k.sign(msg.as_bytes()).to_bytes().to_vec())
}

fn ctx(predecessor: AccountId, deposit: u128, now: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .block_height(100)
        .account_balance(NearToken::from_near(50));
    testing_env!(b.build());
}

/// Contract with a 30 s minimum dispute window, and channel 0 opened by `agent` for `seller`
/// with 1 NEAR, expiring in 1 hour, 60 s dispute window.
fn setup() -> (Contract, SigningKey) {
    ctx(agent(), 0, T0);
    let mut c = Contract::new(U64(30), U64(30 * 24 * 3600));
    let k = key(7);
    ctx(agent(), NEAR, T0);
    let id = c.open_channel(seller(), pubkey(&k), U64(3600), Some(U64(60)));
    assert_eq!(id.0, 0);
    (c, k)
}

fn deposit_of(c: &Contract) -> u128 {
    c.get_channel(U64(0)).unwrap().deposit.0
}

fn expect_panic<F: FnOnce() + std::panic::UnwindSafe>(f: F, code: &str) {
    let err = std::panic::catch_unwind(f).expect_err("expected a panic");
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(msg.contains(code), "panic `{}` does not contain `{}`", msg, code);
}

#[test]
fn voucher_message_format_is_stable() {
    assert_eq!(
        build_voucher_message("channels.tollgate.testnet", 3, 1_000_000_000_000_000_000_000, 7),
        "tollgate:v1:channels.tollgate.testnet:3:1000000000000000000000:7"
    );
}

/// Same vector as test/voucher.test.mjs: proves the Node signer and the contract agree.
#[test]
fn cross_language_test_vector() {
    let k = key(7);
    let msg = build_voucher_message("channels.tollgate.testnet", 0, MILLI, 1);
    let sig = k.sign(msg.as_bytes()).to_bytes();
    let pk = k.verifying_key().to_bytes();
    assert_eq!(
        near_sdk::bs58::encode(pk).into_string(),
        include_str!("../../../test/vectors/pubkey.txt").trim()
    );
    use near_sdk::base64::Engine;
    assert_eq!(
        near_sdk::base64::engine::general_purpose::STANDARD.encode(sig),
        include_str!("../../../test/vectors/signature.txt").trim()
    );
}

#[test]
fn open_channel_takes_storage_fee_and_emits_event() {
    let (c, _) = setup();
    let ch = c.get_channel(U64(0)).unwrap();
    assert_eq!(ch.owner, agent());
    assert_eq!(ch.seller, seller());
    assert!(ch.storage_fee.0 > 0);
    assert_eq!(ch.deposit.0 + ch.storage_fee.0, NEAR);
    assert_eq!(ch.status, ChannelStatus::Open);
    assert_eq!(ch.expires_at_ns.0, T0 + 3600 * SEC);
    assert_eq!(ch.dispute_window_sec.0, 60);
    let logs = get_logs();
    let last = logs.last().unwrap();
    assert!(last.starts_with("EVENT_JSON:"));
    assert!(last.contains("\"standard\":\"tollgate\""));
    assert!(last.contains("\"event\":\"channel_opened\""));
}

#[test]
fn open_rejects_bad_parameters() {
    let (mut c, k) = setup();
    ctx(agent(), NEAR, T0);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.open_channel(seller(), pubkey(&k), U64(3600), Some(U64(5)));
        }),
        "TOLLGATE_BAD_WINDOW",
    );
    let (mut c, k) = setup();
    ctx(agent(), NEAR, T0);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.open_channel(seller(), pubkey(&k), U64(40 * 24 * 3600), None);
        }),
        "TOLLGATE_BAD_EXPIRY",
    );
    let (mut c, k) = setup();
    ctx(agent(), 1000, T0);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.open_channel(seller(), pubkey(&k), U64(3600), None);
        }),
        "TOLLGATE_DEPOSIT_TOO_SMALL",
    );
    let (mut c, k) = setup();
    ctx(agent(), NEAR, T0);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.open_channel(agent(), pubkey(&k), U64(3600), None);
        }),
        "TOLLGATE_BAD_SELLER",
    );
}

#[test]
fn settle_pays_delta_and_tracks_state() {
    let (mut c, k) = setup();
    ctx(seller(), 0, T0 + 10 * SEC);
    let paid = c.settle(U64(0), U128(200 * MILLI), U64(200), sign(&k, 0, 200 * MILLI, 200));
    assert_eq!(paid.0, 200 * MILLI);
    ctx(seller(), 0, T0 + 20 * SEC);
    let paid = c.settle(U64(0), U128(250 * MILLI), U64(250), sign(&k, 0, 250 * MILLI, 250));
    assert_eq!(paid.0, 50 * MILLI, "second settlement pays only the delta");
    let ch = c.get_channel(U64(0)).unwrap();
    assert_eq!(ch.settled.0, 250 * MILLI);
    assert_eq!(ch.last_nonce.0, 250);
    assert_eq!(ch.settlements, 2);
    assert_eq!(ch.remaining.0, deposit_of(&c) - 250 * MILLI);
    let s = c.get_stats();
    assert_eq!(s.total_settled.0, 250 * MILLI);
    assert_eq!(s.total_settlements.0, 2);
    assert!(get_logs().last().unwrap().contains("channel_settled"));
}

#[test]
fn settle_rejects_bad_signature() {
    let (mut c, k) = setup();
    // Signed by a different key.
    let other = key(9);
    ctx(seller(), 0, T0 + SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.settle(U64(0), U128(MILLI), U64(1), sign(&other, 0, MILLI, 1));
        }),
        "TOLLGATE_BAD_SIGNATURE",
    );
    // Right key, tampered amount.
    let (mut c, _) = setup();
    ctx(seller(), 0, T0 + SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.settle(U64(0), U128(2 * MILLI), U64(1), sign(&k, 0, MILLI, 1));
        }),
        "TOLLGATE_BAD_SIGNATURE",
    );
    // Voucher for another channel id (domain separation).
    let (mut c, _) = setup();
    ctx(seller(), 0, T0 + SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.settle(U64(0), U128(MILLI), U64(1), sign(&k, 1, MILLI, 1));
        }),
        "TOLLGATE_BAD_SIGNATURE",
    );
    // Short signature.
    let (mut c, _) = setup();
    ctx(seller(), 0, T0 + SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.settle(U64(0), U128(MILLI), U64(1), Base64VecU8(vec![1, 2, 3]));
        }),
        "TOLLGATE_BAD_SIGNATURE",
    );
}

#[test]
fn voucher_for_another_contract_is_rejected() {
    let (mut c, k) = setup();
    let msg = build_voucher_message("channels.someone-else.testnet", 0, MILLI, 1);
    let sig = Base64VecU8(k.sign(msg.as_bytes()).to_bytes().to_vec());
    ctx(seller(), 0, T0 + SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.settle(U64(0), U128(MILLI), U64(1), sig);
        }),
        "TOLLGATE_BAD_SIGNATURE",
    );
}

#[test]
fn replay_is_rejected() {
    let (mut c, k) = setup();
    ctx(seller(), 0, T0 + SEC);
    c.settle(U64(0), U128(5 * MILLI), U64(5), sign(&k, 0, 5 * MILLI, 5));
    ctx(seller(), 0, T0 + 2 * SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.settle(U64(0), U128(5 * MILLI), U64(5), sign(&k, 0, 5 * MILLI, 5));
        }),
        "TOLLGATE_REPLAY",
    );
    // An older voucher is also a replay.
    let (mut c, k) = setup();
    ctx(seller(), 0, T0 + SEC);
    c.settle(U64(0), U128(5 * MILLI), U64(5), sign(&k, 0, 5 * MILLI, 5));
    ctx(seller(), 0, T0 + 2 * SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.settle(U64(0), U128(3 * MILLI), U64(3), sign(&k, 0, 3 * MILLI, 3));
        }),
        "TOLLGATE_REPLAY",
    );
}

#[test]
fn lower_amount_with_higher_nonce_is_rejected() {
    let (mut c, k) = setup();
    ctx(seller(), 0, T0 + SEC);
    c.settle(U64(0), U128(5 * MILLI), U64(5), sign(&k, 0, 5 * MILLI, 5));
    ctx(seller(), 0, T0 + 2 * SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.settle(U64(0), U128(4 * MILLI), U64(6), sign(&k, 0, 4 * MILLI, 6));
        }),
        "TOLLGATE_STALE_AMOUNT",
    );
}

#[test]
fn overspend_is_rejected() {
    let (mut c, k) = setup();
    let too_much = deposit_of(&c) + 1;
    ctx(seller(), 0, T0 + SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.settle(U64(0), U128(too_much), U64(1), sign(&k, 0, too_much, 1));
        }),
        "TOLLGATE_OVERSPEND",
    );
    // Exactly the deposit is fine.
    let (mut c, k) = setup();
    let all = deposit_of(&c);
    ctx(seller(), 0, T0 + SEC);
    assert_eq!(c.settle(U64(0), U128(all), U64(1), sign(&k, 0, all, 1)).0, all);
}

#[test]
fn only_seller_can_settle() {
    let (mut c, k) = setup();
    for who in [agent(), stranger()] {
        ctx(who, 0, T0 + SEC);
        expect_panic(
            std::panic::AssertUnwindSafe(|| {
                c.settle(U64(0), U128(MILLI), U64(1), sign(&k, 0, MILLI, 1));
            }),
            "TOLLGATE_NOT_SELLER",
        );
    }
}

#[test]
fn only_owner_can_top_up_and_start_close() {
    let (mut c, _) = setup();
    ctx(stranger(), NEAR, T0 + SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.top_up(U64(0), None);
        }),
        "TOLLGATE_NOT_OWNER",
    );
    let (mut c, _) = setup();
    for who in [seller(), stranger()] {
        ctx(who, 0, T0 + SEC);
        expect_panic(
            std::panic::AssertUnwindSafe(|| {
                c.start_close(U64(0));
            }),
            "TOLLGATE_NOT_OWNER",
        );
    }
}

#[test]
fn top_up_adds_deposit_and_extends_expiry() {
    let (mut c, k) = setup();
    let before = deposit_of(&c);
    ctx(agent(), NEAR / 2, T0 + SEC);
    let v = c.top_up(U64(0), Some(U64(600)));
    assert_eq!(v.deposit.0, before + NEAR / 2);
    assert_eq!(v.expires_at_ns.0, T0 + 4200 * SEC);
    // The extra deposit is spendable.
    let amt = before + NEAR / 4;
    ctx(seller(), 0, T0 + 2 * SEC);
    assert_eq!(c.settle(U64(0), U128(amt), U64(1), sign(&k, 0, amt, 1)).0, amt);
}

#[test]
fn dispute_window_lets_seller_settle_then_blocks_finalize_early() {
    let (mut c, k) = setup();
    ctx(agent(), 0, T0 + 100 * SEC);
    let v = c.start_close(U64(0));
    assert_eq!(v.status, ChannelStatus::Closing);
    assert_eq!(v.settle_deadline_ns.0, T0 + 160 * SEC);

    // Agent cannot finalize inside the window.
    ctx(agent(), 0, T0 + 130 * SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.finalize(U64(0));
        }),
        "TOLLGATE_DISPUTE_WINDOW",
    );
    // Seller settles during the window.
    ctx(seller(), 0, T0 + 140 * SEC);
    assert_eq!(c.settle(U64(0), U128(300 * MILLI), U64(300), sign(&k, 0, 300 * MILLI, 300)).0, 300 * MILLI);

    // After the window the seller is too late and the agent gets the rest.
    ctx(seller(), 0, T0 + 161 * SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.settle(U64(0), U128(400 * MILLI), U64(400), sign(&k, 0, 400 * MILLI, 400));
        }),
        "TOLLGATE_SETTLE_WINDOW_OVER",
    );
    let dep = deposit_of(&c);
    ctx(agent(), 0, T0 + 161 * SEC);
    let refund = c.finalize(U64(0));
    assert_eq!(refund.0, dep - 300 * MILLI);
    let ch = c.get_channel(U64(0)).unwrap();
    assert_eq!(ch.status, ChannelStatus::Closed);
    assert_eq!(ch.remaining.0, 0);
    assert_eq!(ch.refunded.0, dep - 300 * MILLI);
    assert!(get_logs().last().unwrap().contains("channel_closed"));
    // Nothing works on a closed channel.
    ctx(agent(), 0, T0 + 200 * SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.finalize(U64(0));
        }),
        "TOLLGATE_CLOSED",
    );
}

#[test]
fn cannot_finalize_open_channel_before_expiry_but_can_after() {
    let (mut c, k) = setup();
    ctx(agent(), 0, T0 + 10 * SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.finalize(U64(0));
        }),
        "TOLLGATE_NOT_CLOSABLE",
    );
    let (mut c, _) = setup();
    let dep = deposit_of(&c);
    // Anyone may trigger the refund after expiry; it always goes to the owner.
    ctx(stranger(), 0, T0 + 3600 * SEC);
    assert_eq!(c.finalize(U64(0)).0, dep);
    // Seller is locked out after expiry.
    let (mut c, _) = setup();
    ctx(seller(), 0, T0 + 3600 * SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.settle(U64(0), U128(MILLI), U64(1), sign(&k, 0, MILLI, 1));
        }),
        "TOLLGATE_SETTLE_WINDOW_OVER",
    );
}

#[test]
fn cooperative_close_settles_and_refunds_at_once() {
    let (mut c, k) = setup();
    ctx(agent(), 0, T0 + SEC);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.cooperative_close(U64(0), None, None, None);
        }),
        "TOLLGATE_NOT_SELLER",
    );
    let (mut c, _) = setup();
    let dep = deposit_of(&c);
    ctx(seller(), 0, T0 + 5 * SEC);
    let refund = c.cooperative_close(
        U64(0),
        Some(U128(42 * MILLI)),
        Some(U64(42)),
        Some(sign(&k, 0, 42 * MILLI, 42)),
    );
    assert_eq!(refund.0, dep - 42 * MILLI);
    let ch = c.get_channel(U64(0)).unwrap();
    assert_eq!(ch.status, ChannelStatus::Closed);
    assert_eq!(ch.settled.0, 42 * MILLI);
    let s = c.get_stats();
    assert_eq!(s.closed.0, 1);
    assert_eq!(s.total_refunded.0, dep - 42 * MILLI);
}

#[test]
fn verify_voucher_view() {
    let (c, k) = setup();
    assert!(c.verify_voucher(U64(0), U128(MILLI), U64(1), sign(&k, 0, MILLI, 1)));
    assert!(!c.verify_voucher(U64(0), U128(MILLI), U64(2), sign(&k, 0, MILLI, 1)));
    assert!(!c.verify_voucher(U64(5), U128(MILLI), U64(1), sign(&k, 0, MILLI, 1)));
    assert_eq!(
        c.voucher_message(U64(0), U128(MILLI), U64(1)),
        "tollgate:v1:channels.tollgate.testnet:0:1000000000000000000000:1"
    );
}

#[test]
fn listing_and_filtering() {
    let (mut c, k) = setup();
    ctx(stranger(), NEAR, T0 + SEC);
    c.open_channel(seller(), pubkey(&k), U64(3600), None);
    ctx(agent(), NEAR, T0 + SEC);
    c.open_channel(stranger(), pubkey(&k), U64(3600), None);
    assert_eq!(c.get_channels(None, None).len(), 3);
    assert_eq!(c.get_channels(Some(U64(1)), Some(1)).len(), 1);
    assert_eq!(c.get_channels_for(agent(), None, None).len(), 2);
    assert_eq!(c.get_channels_for(seller(), None, None).len(), 2);
    assert_eq!(c.get_channels_for(stranger(), None, None).len(), 2);
    assert_eq!(c.get_stats().open.0, 3);
}
