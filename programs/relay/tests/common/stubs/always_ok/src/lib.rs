//! Test stub: returns success (0) for every invocation. No dependencies, no accounts touched.
#![no_std]

/// SBF entrypoint: `input` is the serialized account/instruction blob, ignored.
#[no_mangle]
pub extern "C" fn entrypoint(_input: *mut u8) -> u64 {
    0
}

#[cfg(not(test))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
