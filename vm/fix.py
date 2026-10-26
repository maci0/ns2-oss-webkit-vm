import sys
p = sys.argv[1]
s = open(p).read()
needle = "void ErrorInstance::computeErrorInfo(VM& vm)\n{\n    ASSERT(!m_errorInfoMaterialized);\n"
assert s.count(needle) == 1, "unexpected computeErrorInfo shape: %d" % s.count(needle)
s = s.replace(needle, needle + "    DeferGC deferGC(vm);\n")
open(p, "w").write(s)
print("patched", p)
