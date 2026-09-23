fn main() {
    // tauri-build 自己只声明了对 tauri.conf.json 和 capabilities 的依赖，
    // **没有声明图标文件**。结果是：换了 icons/ 里的图标之后，它不会重新编译
    // Windows 资源，exe 会一直带着旧图标 —— 而且全程没有任何报错，
    // 只有把 exe 里的图标抠出来对比才看得出来。
    //
    // 这里手工补上声明，改图标后构建就会自动重新生成资源。
    println!("cargo:rerun-if-changed=icons");

    tauri_build::build()
}
