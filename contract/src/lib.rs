// PayPerCallRegistry — on-chain registry of paid API listings.
//
// Sellers register paid endpoints; buyers / agent workers read listings
// from chain (get_listings / get_listing) and filter on `active`.
use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near, require};

/// A single paid-API listing. `price_yocto` serializes in JSON as a
/// string of yoctoNEAR (U128), per the task spec.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Listing {
    pub id: String,
    pub seller: AccountId,
    pub name: String,
    pub description: String,
    pub endpoint_url: String,
    pub price_yocto: U128,
    pub active: bool,
}

#[near(contract_state)]
#[derive(Default)]
pub struct PayPerCallRegistry {
    listings: Vec<Listing>,
    next_nonce: u64,
}

#[near]
impl PayPerCallRegistry {
    /// Register a new listing. Seller is the transaction predecessor.
    /// Returns the new listing id (`<seller>-<nonce>`).
    pub fn register_listing(
        &mut self,
        name: String,
        description: String,
        endpoint_url: String,
        price_yocto: U128,
    ) -> String {
        require!(
            !name.is_empty() && name.chars().count() <= 80,
            "name must be 1-80 characters"
        );
        require!(
            description.chars().count() <= 500,
            "description must be at most 500 characters"
        );
        require!(
            endpoint_url.starts_with("http://") || endpoint_url.starts_with("https://"),
            "endpoint_url must start with http:// or https://"
        );
        require!(price_yocto.0 > 0, "price_yocto must be greater than 0");

        let seller = env::predecessor_account_id();
        self.next_nonce += 1;
        let id = format!("{}-{}", seller, self.next_nonce);
        self.listings.push(Listing {
            id: id.clone(),
            seller,
            name,
            description,
            endpoint_url,
            price_yocto,
            active: true,
        });
        id
    }

    /// Update the price of a listing. Only the listing's seller may call.
    pub fn update_price(&mut self, listing_id: String, price_yocto: U128) {
        require!(price_yocto.0 > 0, "price_yocto must be greater than 0");
        let listing = self
            .listings
            .iter_mut()
            .find(|l| l.id == listing_id)
            .unwrap_or_else(|| env::panic_str("listing not found"));
        require!(
            listing.seller == env::predecessor_account_id(),
            "only the seller can update the price"
        );
        listing.price_yocto = price_yocto;
    }

    /// Deactivate a listing (active = false). Only the seller may call.
    pub fn deactivate_listing(&mut self, listing_id: String) {
        let listing = self
            .listings
            .iter_mut()
            .find(|l| l.id == listing_id)
            .unwrap_or_else(|| env::panic_str("listing not found"));
        require!(
            listing.seller == env::predecessor_account_id(),
            "only the seller can deactivate the listing"
        );
        listing.active = false;
    }

    /// All listings, active and inactive (callers filter).
    pub fn get_listings(&self) -> Vec<Listing> {
        self.listings.clone()
    }

    /// A single listing by id, or None.
    pub fn get_listing(&self, listing_id: String) -> Option<Listing> {
        self.listings.iter().find(|l| l.id == listing_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn set_predecessor(predecessor: &str) {
        let account: AccountId = predecessor.parse().unwrap();
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("registry.testnet".parse().unwrap())
            .signer_account_id(account.clone())
            .predecessor_account_id(account);
        testing_env!(builder.build());
    }

    fn register_as_alice(contract: &mut PayPerCallRegistry) -> String {
        set_predecessor("alice.testnet");
        contract.register_listing(
            "Weather API".to_string(),
            "Current weather for a city.".to_string(),
            "https://example.com/weather".to_string(),
            U128(1_000_000_000_000_000_000_000), // 0.001 NEAR
        )
    }

    #[test]
    fn register_happy_path() {
        let mut contract = PayPerCallRegistry::default();
        let id = register_as_alice(&mut contract);
        assert_eq!(id, "alice.testnet-1");
        let listings = contract.get_listings();
        assert_eq!(listings.len(), 1);
        assert_eq!(listings[0].id, id);
        assert_eq!(listings[0].seller.to_string(), "alice.testnet");
        assert_eq!(listings[0].name, "Weather API");
        assert!(listings[0].active);
        assert_eq!(listings[0].price_yocto, U128(1_000_000_000_000_000_000_000));
    }

    #[test]
    fn get_listing_round_trip() {
        let mut contract = PayPerCallRegistry::default();
        let id = register_as_alice(&mut contract);
        let found = contract.get_listing(id.clone()).expect("listing should exist");
        assert_eq!(found.id, id);
        assert_eq!(found.description, "Current weather for a city.");
        assert_eq!(found.endpoint_url, "https://example.com/weather");
        assert_eq!(found.seller.to_string(), "alice.testnet");
        assert!(contract.get_listing("nope-999".to_string()).is_none());
    }

    #[test]
    #[should_panic(expected = "only the seller can update the price")]
    fn non_seller_update_price_panics() {
        let mut contract = PayPerCallRegistry::default();
        let id = register_as_alice(&mut contract);
        set_predecessor("bob.testnet");
        contract.update_price(id, U128(2_000));
    }

    #[test]
    #[should_panic(expected = "only the seller can deactivate the listing")]
    fn non_seller_deactivate_panics() {
        let mut contract = PayPerCallRegistry::default();
        let id = register_as_alice(&mut contract);
        set_predecessor("bob.testnet");
        contract.deactivate_listing(id);
    }

    #[test]
    #[should_panic(expected = "price_yocto must be greater than 0")]
    fn invalid_price_panics() {
        let mut contract = PayPerCallRegistry::default();
        set_predecessor("alice.testnet");
        contract.register_listing(
            "Free API".to_string(),
            "Zero price is invalid.".to_string(),
            "https://example.com/free".to_string(),
            U128(0),
        );
    }

    #[test]
    fn seller_can_update_price_and_deactivate() {
        let mut contract = PayPerCallRegistry::default();
        let id = register_as_alice(&mut contract);
        set_predecessor("alice.testnet");
        contract.update_price(id.clone(), U128(5_000));
        assert_eq!(contract.get_listing(id.clone()).unwrap().price_yocto, U128(5_000));
        contract.deactivate_listing(id.clone());
        assert!(!contract.get_listing(id).unwrap().active);
    }
}
