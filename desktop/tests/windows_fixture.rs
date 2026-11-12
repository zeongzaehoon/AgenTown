use std::{
    io::{self, BufRead, Read},
    time::Duration,
};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("descendant") {
        std::thread::sleep(Duration::from_secs(2));
        std::fs::write("leaked", "bad").unwrap();
        return;
    }
    assert_eq!(
        &args[1..5],
        ["-I", "-m", "llm_engine.desktop", "--database"]
    );
    assert!(std::path::Path::new(&args[5]).is_absolute());
    assert_eq!(args[6], "--port");
    args[7].parse::<u16>().unwrap();
    let mut input = io::stdin().lock();
    let mut identity = String::new();
    input.read_line(&mut identity).unwrap();
    assert!(identity.contains("identity") && identity.contains("token"));
    if std::path::Path::new("force").exists() {
        std::process::Command::new(std::env::current_exe().unwrap())
            .arg("descendant")
            .spawn()
            .unwrap();
        std::fs::write("started", "yes").unwrap();
        std::thread::sleep(Duration::from_secs(60));
    } else {
        input.read_to_end(&mut Vec::new()).unwrap();
        std::fs::write("stopped", "yes").unwrap();
    }
}
