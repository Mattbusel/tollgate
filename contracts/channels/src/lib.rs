//! Tollgate channels: unidirectional NEAR payment channels for HTTP 402 micropayments.
//!
//! An agent (the channel owner) locks a deposit for one seller and registers a dedicated
//! ed25519 "channel key". Every paid API call is then an off-chain voucher signed by that key:
//!
//!   tollgate:v1:<contract_id>:<channel_id>:<cumulative_yocto>:<nonce>
//!
//! The seller keeps the newest voucher and calls `settle` whenever it wants. The contract checks
//! the signature with `env::ed25519_verify`, rejects replays (nonce must grow) and overspends
//! (cumulative must not exceed the deposit), and pays the seller only the delta since the last
//! settlement. The owner can reclaim the unspent remainder: `start_close`, then `finalize` after
//! the channel's dispute window (the seller may still settle during the window), or `finalize`
//! straight away once the channel has expired. A seller can also close cooperatively at any time.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::Vector;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, CurveType, NearToken, PanicOnDefault, Promise,
    PublicKey,
};

pub const VOUCHER_DOMAIN: &str = "tollgate:v1";
pub const EVENT_STANDARD: &str = "tollgate";
pub const EVENT_VERSION: &str = "1.0.0";
const NS_PER_SEC: u64 = 1_000_000_000;
/// Smallest deposit worth opening a channel for, on top of the storage fee (0.01 NEAR).
pub const MIN_CHANNEL_DEPOSIT: u128 = 10_000_000_000_000_000_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Channels,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ChannelStatus {
    Open,
    Closing,
    Closed,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Channel {
    pub owner: AccountId,
    pub seller: AccountId,
    pub agent_pubkey: PublicKey,
    pub deposit: u128,
    pub settled: u128,
    pub refunded: u128,
    pub last_nonce: u64,
    pub settlements: u32,
    pub opened_at_ns: u64,
    pub expires_at_ns: u64,
    pub dispute_window_ns: u64,
    pub close_requested_at_ns: Option<u64>,
    pub closed_at_ns: Option<u64>,
    pub last_settled_block: u64,
    pub storage_fee: u128,
    pub status: ChannelStatus,
}

/// JSON view of a channel. Amounts are yoctoNEAR strings, times are nanoseconds.
#[derive(Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct ChannelView {
    pub channel_id: U64,
    pub owner: AccountId,
    pub seller: AccountId,
    pub agent_pubkey: PublicKey,
    pub deposit: U128,
    pub settled: U128,
    pub remaining: U128,
    pub refunded: U128,
    pub last_nonce: U64,
    pub settlements: u32,
    pub opened_at_ns: U64,
    pub expires_at_ns: U64,
    pub dispute_window_sec: U64,
    pub close_requested_at_ns: Option<U64>,
    pub closed_at_ns: Option<U64>,
    /// Last moment (ns) the seller can settle, given the current status.
    pub settle_deadline_ns: U64,
    pub last_settled_block: U64,
    pub storage_fee: U128,
    pub status: ChannelStatus,
}

#[derive(Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct Config {
    pub voucher_domain: String,
    pub min_dispute_window_sec: U64,
    pub max_expiry_sec: U64,
    pub min_channel_deposit: U128,
}

#[derive(Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct Stats {
    pub channels: U64,
    pub open: U64,
    pub closing: U64,
    pub closed: U64,
    pub total_deposited: U128,
    pub total_settled: U128,
    pub total_refunded: U128,
    pub total_settlements: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    channels: Vector<Channel>,
    min_dispute_window_ns: u64,
    max_expiry_ns: u64,
    total_deposited: u128,
    total_settled: u128,
    total_refunded: u128,
    total_settlements: u64,
}

fn fail(code: &str, detail: String) -> ! {
    env::panic_str(&format!("TOLLGATE_{}: {}", code, detail))
}

fn emit(event: &str, data: serde_json::Value) {
    let ev = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", ev));
}

/// The exact bytes an agent signs for a voucher (UTF-8). Account ids cannot contain ':' so the
/// encoding is unambiguous.
pub fn build_voucher_message(contract_id: &str, channel_id: u64, cumulative: u128, nonce: u64) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        VOUCHER_DOMAIN, contract_id, channel_id, cumulative, nonce
    )
}

fn ed25519_bytes(pk: &PublicKey) -> [u8; 32] {
    let raw = pk.as_bytes();
    // near-sdk PublicKey bytes are [curve_type, key...]
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw[1..33]);
    out
}

impl Channel {
    fn settle_deadline_ns(&self) -> u64 {
        match (self.status, self.close_requested_at_ns) {
            (ChannelStatus::Closed, _) => self.closed_at_ns.unwrap_or(0),
            (ChannelStatus::Closing, Some(req)) => {
                std::cmp::min(self.expires_at_ns, req.saturating_add(self.dispute_window_ns))
            }
            _ => self.expires_at_ns,
        }
    }

    fn view(&self, id: u64) -> ChannelView {
        ChannelView {
            channel_id: U64(id),
            owner: self.owner.clone(),
            seller: self.seller.clone(),
            agent_pubkey: self.agent_pubkey.clone(),
            deposit: U128(self.deposit),
            settled: U128(self.settled),
            remaining: U128(self.deposit - self.settled - self.refunded),
            refunded: U128(self.refunded),
            last_nonce: U64(self.last_nonce),
            settlements: self.settlements,
            opened_at_ns: U64(self.opened_at_ns),
            expires_at_ns: U64(self.expires_at_ns),
            dispute_window_sec: U64(self.dispute_window_ns / NS_PER_SEC),
            close_requested_at_ns: self.close_requested_at_ns.map(U64),
            closed_at_ns: self.closed_at_ns.map(U64),
            settle_deadline_ns: U64(self.settle_deadline_ns()),
            last_settled_block: U64(self.last_settled_block),
            storage_fee: U128(self.storage_fee),
            status: self.status,
        }
    }
}

#[near]
impl Contract {
    /// `min_dispute_window_sec`: shortest dispute window an agent may choose when opening a
    /// channel. `max_expiry_sec`: longest channel lifetime.
    #[init]
    pub fn new(min_dispute_window_sec: U64, max_expiry_sec: U64) -> Self {
        require!(max_expiry_sec.0 > min_dispute_window_sec.0, "max_expiry_sec must exceed min_dispute_window_sec");
        Self {
            channels: Vector::new(StorageKey::Channels),
            min_dispute_window_ns: min_dispute_window_sec.0 * NS_PER_SEC,
            max_expiry_ns: max_expiry_sec.0 * NS_PER_SEC,
            total_deposited: 0,
            total_settled: 0,
            total_refunded: 0,
            total_settlements: 0,
        }
    }

    // ------------------------------------------------------------------ agent (owner) side

    /// Lock the attached deposit for `seller`. `agent_pubkey` is the dedicated ed25519 channel
    /// key that signs vouchers (not an account key). The storage cost of the channel record is
    /// taken from the attached deposit; the rest is spendable. Returns the channel id.
    #[payable]
    pub fn open_channel(
        &mut self,
        seller: AccountId,
        agent_pubkey: PublicKey,
        expires_in_sec: U64,
        dispute_window_sec: Option<U64>,
    ) -> U64 {
        let owner = env::predecessor_account_id();
        require!(seller != owner, "TOLLGATE_BAD_SELLER: seller cannot be the channel owner");
        if agent_pubkey.curve_type() != CurveType::ED25519 {
            fail("BAD_KEY", "agent_pubkey must be an ed25519 key".into());
        }
        let window_ns = dispute_window_sec
            .map(|w| w.0 * NS_PER_SEC)
            .unwrap_or(self.min_dispute_window_ns);
        if window_ns < self.min_dispute_window_ns {
            fail(
                "BAD_WINDOW",
                format!("dispute window must be at least {} s", self.min_dispute_window_ns / NS_PER_SEC),
            );
        }
        let expires_ns = expires_in_sec.0 * NS_PER_SEC;
        if expires_ns <= window_ns || expires_ns > self.max_expiry_ns {
            fail(
                "BAD_EXPIRY",
                format!(
                    "expires_in_sec must be above the dispute window and at most {}",
                    self.max_expiry_ns / NS_PER_SEC
                ),
            );
        }

        let attached = env::attached_deposit().as_yoctonear();
        let now = env::block_timestamp();
        let id = self.channels.len() as u64;
        let before = env::storage_usage();
        self.channels.push(Channel {
            owner: owner.clone(),
            seller: seller.clone(),
            agent_pubkey: agent_pubkey.clone(),
            deposit: 0,
            settled: 0,
            refunded: 0,
            last_nonce: 0,
            settlements: 0,
            opened_at_ns: now,
            expires_at_ns: now + expires_ns,
            dispute_window_ns: window_ns,
            close_requested_at_ns: None,
            closed_at_ns: None,
            last_settled_block: 0,
            storage_fee: 0,
            status: ChannelStatus::Open,
        });
        self.channels.flush();
        let used = env::storage_usage().saturating_sub(before) as u128;
        // Reserve a little headroom for the record growing (Some(..) fields filled in later).
        let fee = (used + 32) * env::storage_byte_cost().as_yoctonear();
        if attached < fee + MIN_CHANNEL_DEPOSIT {
            fail(
                "DEPOSIT_TOO_SMALL",
                format!("attach at least {} yoctoNEAR (storage {} + minimum deposit {})", fee + MIN_CHANNEL_DEPOSIT, fee, MIN_CHANNEL_DEPOSIT),
            );
        }
        let deposit = attached - fee;
        let ch = self.channels.get_mut(id as u32).unwrap();
        ch.deposit = deposit;
        ch.storage_fee = fee;
        let expires_at = ch.expires_at_ns;
        self.total_deposited += deposit;

        emit(
            "channel_opened",
            json!({
                "channel_id": id.to_string(),
                "owner": owner,
                "seller": seller,
                "agent_pubkey": agent_pubkey,
                "deposit": deposit.to_string(),
                "storage_fee": fee.to_string(),
                "expires_at_ns": expires_at.to_string(),
                "dispute_window_sec": (window_ns / NS_PER_SEC).to_string(),
            }),
        );
        U64(id)
    }

    /// Add the attached deposit to an open channel, optionally pushing its expiry out.
    #[payable]
    pub fn top_up(&mut self, channel_id: U64, extend_expiry_sec: Option<U64>) -> ChannelView {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "TOLLGATE_NO_DEPOSIT: attach NEAR to top up");
        let max_expiry = self.max_expiry_ns;
        let ch = self.channel_mut(channel_id.0);
        if env::predecessor_account_id() != ch.owner {
            fail("NOT_OWNER", "only the channel owner can top up".into());
        }
        if ch.status != ChannelStatus::Open || env::block_timestamp() >= ch.expires_at_ns {
            fail("NOT_OPEN", "channel is closing, closed or expired".into());
        }
        ch.deposit += amount;
        if let Some(ext) = extend_expiry_sec {
            let new_exp = ch.expires_at_ns + ext.0 * NS_PER_SEC;
            if new_exp > env::block_timestamp() + max_expiry {
                fail("BAD_EXPIRY", "extension goes past the maximum channel lifetime".into());
            }
            ch.expires_at_ns = new_exp;
        }
        let view = ch.view(channel_id.0);
        self.total_deposited += amount;
        emit(
            "channel_topped_up",
            json!({
                "channel_id": channel_id.0.to_string(),
                "amount": amount.to_string(),
                "deposit": view.deposit,
                "expires_at_ns": view.expires_at_ns,
            }),
        );
        view
    }

    /// Owner starts a unilateral close. The seller can still settle until the dispute window
    /// (or the expiry, whichever comes first) has passed; then anyone can call `finalize`.
    pub fn start_close(&mut self, channel_id: U64) -> ChannelView {
        let ch = self.channel_mut(channel_id.0);
        if env::predecessor_account_id() != ch.owner {
            fail("NOT_OWNER", "only the channel owner can start a close".into());
        }
        if ch.status != ChannelStatus::Open {
            fail("NOT_OPEN", "channel is already closing or closed".into());
        }
        ch.status = ChannelStatus::Closing;
        ch.close_requested_at_ns = Some(env::block_timestamp());
        let view = ch.view(channel_id.0);
        emit(
            "channel_close_started",
            json!({
                "channel_id": channel_id.0.to_string(),
                "settle_deadline_ns": view.settle_deadline_ns,
            }),
        );
        view
    }

    /// Refund the unspent remainder to the owner once the seller can no longer settle: after
    /// the dispute window of a closing channel, or after expiry. Callable by anyone; the money
    /// only ever goes to the owner.
    pub fn finalize(&mut self, channel_id: U64) -> U128 {
        let now = env::block_timestamp();
        let ch = self.channel_mut(channel_id.0);
        match ch.status {
            ChannelStatus::Closed => fail("CLOSED", "channel is already closed".into()),
            ChannelStatus::Open if now < ch.expires_at_ns => fail(
                "NOT_CLOSABLE",
                "call start_close first, or wait for the channel to expire".into(),
            ),
            ChannelStatus::Closing if now < ch.settle_deadline_ns() => fail(
                "DISPUTE_WINDOW",
                format!(
                    "the seller can still settle for {} more seconds",
                    (ch.settle_deadline_ns() - now) / NS_PER_SEC + 1
                ),
            ),
            _ => {}
        }
        let refund = ch.deposit - ch.settled;
        ch.refunded = refund;
        ch.status = ChannelStatus::Closed;
        ch.closed_at_ns = Some(now);
        let owner = ch.owner.clone();
        let settled = ch.settled;
        self.total_refunded += refund;
        emit(
            "channel_closed",
            json!({
                "channel_id": channel_id.0.to_string(),
                "how": "finalize",
                "settled": settled.to_string(),
                "refunded": refund.to_string(),
                "owner": owner,
            }),
        );
        if refund > 0 {
            Promise::new(owner).transfer(NearToken::from_yoctonear(refund)).detach();
        }
        U128(refund)
    }

    // ------------------------------------------------------------------ seller side

    /// Seller cashes the newest voucher. Pays the seller `cumulative_amount - settled` and
    /// returns that delta.
    pub fn settle(
        &mut self,
        channel_id: U64,
        cumulative_amount: U128,
        nonce: U64,
        signature: Base64VecU8,
    ) -> U128 {
        let contract_id = env::current_account_id();
        let ch = self.channel_mut(channel_id.0);
        if env::predecessor_account_id() != ch.seller {
            fail("NOT_SELLER", "only the channel's seller can settle".into());
        }
        let paid = Self::apply_voucher(&contract_id, channel_id.0, ch, cumulative_amount.0, nonce.0, &signature.0);
        let seller = ch.seller.clone();
        let view = ch.view(channel_id.0);
        self.total_settled += paid;
        self.total_settlements += 1;
        emit(
            "channel_settled",
            json!({
                "channel_id": channel_id.0.to_string(),
                "seller": seller,
                "paid": paid.to_string(),
                "cumulative": view.settled,
                "nonce": view.last_nonce,
                "remaining": view.remaining,
            }),
        );
        if paid > 0 {
            Promise::new(seller).transfer(NearToken::from_yoctonear(paid)).detach();
        }
        U128(paid)
    }

    /// Seller ends the channel early: optionally settles a final voucher, then refunds the rest
    /// to the owner immediately. Returns the refund.
    pub fn cooperative_close(
        &mut self,
        channel_id: U64,
        cumulative_amount: Option<U128>,
        nonce: Option<U64>,
        signature: Option<Base64VecU8>,
    ) -> U128 {
        let contract_id = env::current_account_id();
        let now = env::block_timestamp();
        let ch = self.channel_mut(channel_id.0);
        if env::predecessor_account_id() != ch.seller {
            fail("NOT_SELLER", "only the channel's seller can close cooperatively".into());
        }
        if ch.status == ChannelStatus::Closed {
            fail("CLOSED", "channel is already closed".into());
        }
        let mut paid = 0u128;
        if let (Some(c), Some(n), Some(s)) = (cumulative_amount, nonce, signature) {
            paid = Self::apply_voucher(&contract_id, channel_id.0, ch, c.0, n.0, &s.0);
        }
        let refund = ch.deposit - ch.settled;
        ch.refunded = refund;
        ch.status = ChannelStatus::Closed;
        ch.closed_at_ns = Some(now);
        let owner = ch.owner.clone();
        let seller = ch.seller.clone();
        let settled = ch.settled;
        let nonce_now = ch.last_nonce;
        self.total_refunded += refund;
        if paid > 0 {
            self.total_settled += paid;
            self.total_settlements += 1;
            emit(
                "channel_settled",
                json!({
                    "channel_id": channel_id.0.to_string(),
                    "seller": seller,
                    "paid": paid.to_string(),
                    "cumulative": settled.to_string(),
                    "nonce": nonce_now.to_string(),
                    "remaining": refund.to_string(),
                }),
            );
            Promise::new(seller).transfer(NearToken::from_yoctonear(paid)).detach();
        }
        emit(
            "channel_closed",
            json!({
                "channel_id": channel_id.0.to_string(),
                "how": "cooperative",
                "settled": settled.to_string(),
                "refunded": refund.to_string(),
                "owner": owner,
            }),
        );
        if refund > 0 {
            Promise::new(owner).transfer(NearToken::from_yoctonear(refund)).detach();
        }
        U128(refund)
    }

    // ------------------------------------------------------------------ views

    pub fn get_config(&self) -> Config {
        Config {
            voucher_domain: VOUCHER_DOMAIN.to_string(),
            min_dispute_window_sec: U64(self.min_dispute_window_ns / NS_PER_SEC),
            max_expiry_sec: U64(self.max_expiry_ns / NS_PER_SEC),
            min_channel_deposit: U128(MIN_CHANNEL_DEPOSIT),
        }
    }

    pub fn get_channel(&self, channel_id: U64) -> Option<ChannelView> {
        self.channels
            .get(channel_id.0 as u32)
            .map(|c| c.view(channel_id.0))
    }

    /// Channels by id, ascending.
    pub fn get_channels(&self, from_index: Option<U64>, limit: Option<u32>) -> Vec<ChannelView> {
        let from = from_index.map(|v| v.0).unwrap_or(0) as u32;
        let limit = limit.unwrap_or(50).min(200);
        (from..self.channels.len())
            .take(limit as usize)
            .map(|i| self.channels[i].view(i as u64))
            .collect()
    }

    /// Channels where `account_id` is the owner or the seller (scans up to `scan` records).
    pub fn get_channels_for(&self, account_id: AccountId, from_index: Option<U64>, scan: Option<u32>) -> Vec<ChannelView> {
        let from = from_index.map(|v| v.0).unwrap_or(0) as u32;
        let scan = scan.unwrap_or(500).min(2000);
        (from..self.channels.len())
            .take(scan as usize)
            .filter(|i| {
                let c = &self.channels[*i];
                c.owner == account_id || c.seller == account_id
            })
            .map(|i| self.channels[i].view(i as u64))
            .collect()
    }

    pub fn get_stats(&self) -> Stats {
        let (mut open, mut closing, mut closed) = (0u64, 0u64, 0u64);
        for c in self.channels.iter() {
            match c.status {
                ChannelStatus::Open => open += 1,
                ChannelStatus::Closing => closing += 1,
                ChannelStatus::Closed => closed += 1,
            }
        }
        Stats {
            channels: U64(self.channels.len() as u64),
            open: U64(open),
            closing: U64(closing),
            closed: U64(closed),
            total_deposited: U128(self.total_deposited),
            total_settled: U128(self.total_settled),
            total_refunded: U128(self.total_refunded),
            total_settlements: U64(self.total_settlements),
        }
    }

    /// The exact UTF-8 string an agent must sign for this voucher.
    pub fn voucher_message(&self, channel_id: U64, cumulative_amount: U128, nonce: U64) -> String {
        build_voucher_message(env::current_account_id().as_str(), channel_id.0, cumulative_amount.0, nonce.0)
    }

    /// Check a voucher against the channel key on chain without settling it.
    pub fn verify_voucher(&self, channel_id: U64, cumulative_amount: U128, nonce: U64, signature: Base64VecU8) -> bool {
        let Some(ch) = self.channels.get(channel_id.0 as u32) else { return false };
        let Ok(sig) = <[u8; 64]>::try_from(signature.0.as_slice()) else { return false };
        let msg = build_voucher_message(env::current_account_id().as_str(), channel_id.0, cumulative_amount.0, nonce.0);
        env::ed25519_verify(&sig, msg.as_bytes(), &ed25519_bytes(&ch.agent_pubkey))
    }

    // ------------------------------------------------------------------ internals

    fn channel_mut(&mut self, id: u64) -> &mut Channel {
        if id >= self.channels.len() as u64 {
            fail("NO_CHANNEL", format!("channel {} does not exist", id));
        }
        self.channels.get_mut(id as u32).unwrap()
    }

    /// Verify a voucher and move `settled` forward. Returns the delta to pay the seller.
    fn apply_voucher(contract_id: &AccountId, id: u64, ch: &mut Channel, cumulative: u128, nonce: u64, signature: &[u8]) -> u128 {
        let now = env::block_timestamp();
        if ch.status == ChannelStatus::Closed {
            fail("CLOSED", "channel is closed".into());
        }
        if now >= ch.settle_deadline_ns() {
            fail("SETTLE_WINDOW_OVER", "the settlement deadline for this channel has passed".into());
        }
        let sig: [u8; 64] = match signature.try_into() {
            Ok(s) => s,
            Err(_) => fail("BAD_SIGNATURE", "signature must be 64 bytes".into()),
        };
        let msg = build_voucher_message(contract_id.as_str(), id, cumulative, nonce);
        if !env::ed25519_verify(&sig, msg.as_bytes(), &ed25519_bytes(&ch.agent_pubkey)) {
            fail("BAD_SIGNATURE", "voucher signature does not match the channel key".into());
        }
        if nonce <= ch.last_nonce {
            fail(
                "REPLAY",
                format!("nonce {} is not above the last settled nonce {}", nonce, ch.last_nonce),
            );
        }
        if cumulative > ch.deposit {
            fail(
                "OVERSPEND",
                format!("voucher for {} yoctoNEAR exceeds the channel deposit of {}", cumulative, ch.deposit),
            );
        }
        if cumulative < ch.settled {
            fail(
                "STALE_AMOUNT",
                format!("cumulative {} is below the already settled {}", cumulative, ch.settled),
            );
        }
        let delta = cumulative - ch.settled;
        ch.settled = cumulative;
        ch.last_nonce = nonce;
        ch.settlements += 1;
        ch.last_settled_block = env::block_height();
        delta
    }
}

#[cfg(test)]
mod tests;
