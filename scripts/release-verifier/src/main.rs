use minisign_verify::{PublicKey, Signature};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(
        args.len(),
        4,
        "usage: verifier public-key signature artifact"
    );
    let public_key = PublicKey::from_file(&args[1]).expect("Invalid updater public key");
    let signature = Signature::from_file(&args[2]).expect("Invalid updater signature");
    let data = std::fs::read(&args[3]).expect("Missing updater artifact");
    public_key
        .verify(&data, &signature, true)
        .expect("Updater signature verification failed");
}
