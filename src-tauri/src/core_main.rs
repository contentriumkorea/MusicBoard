fn main() {
    if let Err(error)=musicboard_native::stdio_main() { eprintln!("{error}");std::process::exit(1); }
}
