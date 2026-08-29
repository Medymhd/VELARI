use std::{fs, path::PathBuf};

fn vault_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("APPDATA") {
        return PathBuf::from(p).join("app").join("vault");
    }
    std::env::temp_dir().join("app-vault-fallback")
}

fn file_for(key: &str) -> PathBuf {
    let safe: String = key
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    vault_dir().join(format!("{}.bin", safe))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB as DATA_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };

    fn to_blob(data: &[u8]) -> DATA_BLOB {
        DATA_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    pub fn write(key: &str, value: &str) -> Result<(), String> {
        let path = file_for(key);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let plain = value.as_bytes();
        let plain_blob = to_blob(plain);
        let mut cipher_blob = DATA_BLOB::default();
        unsafe {
            CryptProtectData(
                &plain_blob,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut cipher_blob,
            )
            .map_err(|e| format!("CryptProtectData failed: {e:?}"))?;
            let slice = std::slice::from_raw_parts(cipher_blob.pbData, cipher_blob.cbData as usize);
            fs::write(&path, slice).map_err(|e| e.to_string())?;
            LocalFree(HLOCAL(cipher_blob.pbData as *mut core::ffi::c_void));
        }
        Ok(())
    }

    pub fn read(key: &str) -> Result<Option<String>, String> {
        let path = file_for(key);
        if !path.exists() {
            return Ok(None);
        }
        let cipher = fs::read(&path).map_err(|e| e.to_string())?;
        let mut cipher_blob = to_blob(&cipher);
        let mut plain_blob = DATA_BLOB::default();
        unsafe {
            CryptUnprotectData(
                &mut cipher_blob,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut plain_blob,
            )
            .map_err(|e| format!("CryptUnprotectData failed: {e:?}"))?;
            let slice = std::slice::from_raw_parts(plain_blob.pbData, plain_blob.cbData as usize);
            let s = String::from_utf8(slice.to_vec()).map_err(|e| e.to_string())?;
            LocalFree(HLOCAL(plain_blob.pbData as *mut core::ffi::c_void));
            Ok(Some(s))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn write(key: &str, value: &str) -> Result<(), String> {
        let path = file_for(key);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(path, value).map_err(|e| e.to_string())
    }
    pub fn read(key: &str) -> Result<Option<String>, String> {
        let path = file_for(key);
        if !path.exists() {
            return Ok(None);
        }
        fs::read_to_string(path).map(Some).map_err(|e| e.to_string())
    }
}

pub use imp::{read, write};
