set pagination off
set confirm off
set architecture aarch64
target remote 127.0.0.1:2345

break JSC::ErrorInstance::computeErrorInfo(JSC::VM&)
commands
silent
printf "\n===== computeErrorInfo ENTER (outer/inner) =====\n"
bt 15
continue
end

break JSC::ErrorInstance::finalizeUnconditionally(JSC::VM&)
commands
silent
printf "\n===== ErrorInstance::finalizeUnconditionally ENTER (GC) =====\n"
bt 10
continue
end

continue
printf "\n===== SIGNAL STOP =====\n"
bt 30
printf "\n===== REGISTERS =====\n"
info registers pc sp x0 x1 x2 x3 x4 x5
printf "\n===== INSN =====\n"
x/8i $pc
info frame
