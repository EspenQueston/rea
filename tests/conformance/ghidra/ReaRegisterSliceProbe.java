//@category REA Verification
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.program.model.address.AddressSet;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.lang.reflect.InvocationTargetException;
import java.math.BigInteger;

/** Calls the production raw-p-code capture on independently authored ARM byte fixtures. */
public class ReaRegisterSliceProbe extends GhidraScript {
    @Override public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 2) throw new IllegalArgumentException("bridge directory and output JSON required");
        var source = GhidraScriptUtil.findScriptByName("ReaGhidraBridge.java");
        if (source == null || !new File(source.getAbsolutePath()).getCanonicalFile().equals(new File(args[0], "ReaGhidraBridge.java").getCanonicalFile())) throw new IllegalStateException("Wrong bridge source");
        GhidraScript bridge = GhidraScriptUtil.getProvider(source).getScriptInstance(source, errorWriter);
        bridge.set(getState(), getControls());
        var admittedDigest = bridge.getClass().getDeclaredField("admittedTargetSha256"); admittedDigest.setAccessible(true);
        admittedDigest.set(bridge, java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(Path.of(currentProgram.getExecutablePath())))));
        var space = bridge.getClass().getDeclaredField("sessionDefaultAddressSpace"); space.setAccessible(true); space.set(null, currentProgram.getAddressFactory().getDefaultAddressSpace());
        var capture = bridge.getClass().getDeclaredMethod("captureRegisterSlice", JsonObject.class); capture.setAccessible(true);
        int[] lengths = {8,12,24,16,20,4,12,12,12,8,8,8};
        int[] seeds = {4,8,20,12,16,0,4,8,8,4,4,4};
        JsonArray observations = new JsonArray();
        currentProgram.getProgramContext().setValue(currentProgram.getRegister("TMode"), currentProgram.getMinAddress(), currentProgram.getMaxAddress(), BigInteger.ZERO);
        for (int i = 0; i < lengths.length; i++) {
            var start = toAddr(0x1000 + i * 0x100);
            if (!disassemble(start)) throw new IllegalStateException("decode fixture " + i);
            // Decode unreachable instructions too, so missing CFG cannot masquerade as a missing instruction.
            for (int offset = 0; offset < lengths[i]; offset += 4) disassemble(start.add(offset));
            var function = createFunction(start, "slice_fixture_" + i);
            if (function == null) function = currentProgram.getFunctionManager().getFunctionAt(start);
            function.setBody(new AddressSet(start, start.add(lengths[i] - 1)));
            JsonObject query = new JsonObject(); query.addProperty("procedure", "0x" + Long.toHexString(start.getOffset()));
            query.addProperty("instruction", "0x" + Long.toHexString(start.add(seeds[i]).getOffset()));
            JsonObject value = new JsonObject(); value.addProperty("register", "r0"); query.add("value", value);
            query.addProperty("when", "before"); query.addProperty("max_instructions", 80); query.addProperty("max_operations", 1000); query.addProperty("max_nodes", 300); query.addProperty("max_edges", 600);
            observations.add((JsonObject) capture.invoke(bridge, query));
            if (i == 0) {
                var invalid = query.deepCopy(); invalid.addProperty("instruction", "0x1001");
                try { capture.invoke(bridge, invalid); throw new IllegalStateException("interior address accepted"); }
                catch (InvocationTargetException expected) { if (!expected.getCause().getMessage().contains("exact instruction")) throw expected; }
                invalid.addProperty("instruction", "0x1100");
                try { capture.invoke(bridge, invalid); throw new IllegalStateException("foreign function accepted"); }
                catch (InvocationTargetException expected) { if (!expected.getCause().getMessage().contains("exact instruction")) throw expected; }
            }
        }
        // Both instructions/functions now exist: isolate function-membership validation.
        if (currentProgram.getListing().getInstructionAt(toAddr(0x1100)) == null) throw new IllegalStateException("Foreign instruction missing");
        var foreign = observations.get(0).getAsJsonObject().getAsJsonObject("query").deepCopy();
        foreign.addProperty("instruction", "0x1100");
        try { capture.invoke(bridge, foreign); throw new IllegalStateException("foreign decoded instruction accepted"); }
        catch (InvocationTargetException expected) { if (!expected.getCause().getMessage().contains("exact instruction")) throw expected; }
        // All function bytes remain decoded, but the successor is inside an
        // instruction. Byte counts alone must not certify complete CFG coverage.
        var first = currentProgram.getListing().getInstructionAt(toAddr(0x1000));
        first.setFallThrough(toAddr(0x1002));
        var missing = (JsonObject) capture.invoke(bridge, observations.get(0).getAsJsonObject().getAsJsonObject("query"));
        if (!missing.getAsJsonArray("limitations").toString().contains("no captured operation"))
            throw new IllegalStateException("Missing CFG destination reported as complete");
        first.clearFallThroughOverride();
        Files.writeString(Path.of(args[1]), observations.toString());
        println("REA_REGISTER_SLICE_CAPTURE_OK fixtures=" + observations.size());
    }
}
